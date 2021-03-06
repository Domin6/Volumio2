var libQ = require('kew');
var libFast = require('fast.js');
var libSortOn = require('sort-on');
var libCrypto = require('crypto');
var libBase64Url = require('base64-url');
var libLevel = require('level');
var libUtil = require('util');

// Define the CoreMusicLibrary class
module.exports = CoreMusicLibrary;
function CoreMusicLibrary (commandRouter) {
	// This fixed variable will let us refer to 'this' object at deeper scopes
	var self = this;

	// Save a reference to the parent commandRouter
	self.commandRouter = commandRouter;

	// The library contains hash tables for genres, artists, albums, and tracks
	self.library = new Object();
	self.arrayIndexDefinitions = [
		{
			'name': 'Genres by Name',
			'table': 'genre',
			'sortby': 'name',
			'datafields': {
				'name': 'name'
			}
		},
		{
			'name': 'Artists by Name',
			'table': 'artist',
			'sortby': 'name',
			'datafields': {
				'name': 'name',
				'genres': 'parents:#:name'
			}
		},
		{
			'name': 'Albums by Name',
			'table': 'album',
			'sortby': 'name',
			'datafields': {
				'name': 'name',
				'artists': 'parents:#:name'
			}
		},
		{
			'name': 'Albums by Artist',
			'table': 'album',
			'sortby': 'parents:#:name',
			'datafields': {
				'name': 'name',
				'artists': 'parents:#:name'
			}
		},
		{
			'name': 'Tracks by Name',
			'table': 'track',
			'sortby': 'name',
			'datafields': {
				'name': 'name',
				'album': 'parents:#0:name',
				'artists': 'parents:#0:parents:#:name'
			}
		}
	];

	// Start library promise as rejected, so requestors do not wait for it if not immediately available.
	// This is okay because no part of Volumio requires a populated library to function.
	self.libraryReadyDeferred = null;
	self.libraryReady = libQ.reject('Library not yet loaded.');

	// Attempt to load library from database on disk
	self.sLibraryPath = './db/MusicLibrary';
	self.loadLibraryFromDB()
		.fail(libFast.bind(self.pushError, self));
}

// Public methods -----------------------------------------------------------------------------------

// Return a music library view for a given object UID
CoreMusicLibrary.prototype.browseLibrary = function(sUid, sSortBy, nEntries, nOffset) {
	var self = this;
	self.commandRouter.pushConsoleMessage('[' + Date.now() + '] ' + 'CoreMusicLibrary::browseLibrary');

	//TODO implement use of nEntries and nOffset for paging of results

	return self.libraryReady
		.then(function() {
			if (sUid === '') {
				// No object specified, list all the indexes instead
				return libFast.map(self.arrayIndexDefinitions, function(curEntry) {
					return {'uid': 'index:' + curEntry.name, 'datavalues': {'name': curEntry.name}};
				});
			}

			var sPrefix = sUid.split(':')[0];

			if (sPrefix === 'index') {
				// An index is specified. List the contents of the index.
				return self.getLibraryObject(self.library, sUid);
			} else if (sPrefix === 'item') {
				// TODO implement this
				return null;
			} else {
				// A library object is specified. List the children of the object, sorted by name.
				var objDataFields = new Object();

				if (sPrefix === 'genre') {
					// List artists in a given genre
					objDataFields = {'name': 'name', 'genres': 'parents:#:name'};
					if (!sSortBy) {
						sSortBy = 'name';
					}
				} else if (sPrefix === 'artist') {
					// List albums by a given artist
					objDataFields = {'name': 'name', 'artists': 'parents:#:name', 'date': 'children:#0:date'};
					if (!sSortBy) {
						sSortBy = 'date';
					}
				} else if (sPrefix === 'album') {
					// List tracks in a given album
					objDataFields = {'name': 'name', 'album': 'parents:#0:name', 'artists': 'parents:#0:parents:#:name', 'tracknumber': 'tracknumber', 'date': 'date'};
					if (!sSortBy) {
						sSortBy = 'tracknumber';
					}
				} else if (sPrefix === 'track') {
					// List versions of a given track (among the available services)
					objDataFields = {'service': 'service', 'uri': 'uri'};
					if (!sSortBy) {
						sSortBy = 'service';
					}
				}

				var objRequested = self.getLibraryObject(self.library, sUid)
				// self.commandRouter.pushConsoleMessage(objRequested);

				return self.generateSortedIndex(Object.keys(objRequested.children), sSortBy, objDataFields);
			}
		});
}

// Load a LevelDB from disk containing the music library and indexes
CoreMusicLibrary.prototype.loadLibraryFromDB = function() {
	var self = this;
	self.commandRouter.pushConsoleMessage('[' + Date.now() + '] ' + 'CoreMusicLibrary::loadLibraryFromDB');

	self.library = new Object();

	self.libraryReadyDeferred = libQ.defer();
	self.libraryReady = self.libraryReadyDeferred.promise;

	var dbLibrary = libLevel(self.sLibraryPath, {'valueEncoding': 'json', 'createIfMissing': true});
	return libQ.resolve()
		.then(function() {
			return libQ.nfcall(libFast.bind(dbLibrary.get, dbLibrary), 'library');
		})
		.then(function(result) {
			self.library = result;
			self.commandRouter.pushConsoleMessage('Library loaded from DB.');

			try {
				self.libraryReadyDeferred.resolve();
			} catch (error) {
				self.pushError('Unable to resolve library promise: ' + error);
			}

			self.commandRouter.pushConsoleMessage('  Genres: ' + Object.keys(self.library['genre']).length);
			self.commandRouter.pushConsoleMessage('  Artists: ' + Object.keys(self.library['artist']).length);
			self.commandRouter.pushConsoleMessage('  Albums: ' + Object.keys(self.library['album']).length);
			self.commandRouter.pushConsoleMessage('  Tracks: ' + Object.keys(self.library['track']).length);
			self.commandRouter.pushConsoleMessage('  Items: ' + Object.keys(self.library['item']).length);
			self.commandRouter.pushConsoleMessage('  Indexes: ' + Object.keys(self.library['index']).length);

			return libQ.resolve();
		})
		.fail(function(sError) {
			try {
				self.libraryReadyDeferred.reject(sError);
			} catch (error) {
				self.pushError('Unable to reject library promise: ' + error);
			}

			throw new Error('Error reading DB: ' + sError);
		})
		.fin(libFast.bind(dbLibrary.close, dbLibrary));
}

// Query all services for their tracklists, scan each track, and build music library
// This currently needs to be rerun when any tracklist changes, TODO make this updatable in place
CoreMusicLibrary.prototype.rebuildLibrary = function() {
	var self = this;
	self.commandRouter.pushConsoleMessage('[' + Date.now() + '] ' + 'CoreMusicLibrary::rebuildLibrary');

	self.library = new Object();
	self.library['genre'] = new Object();
	self.library['artist'] = new Object();
	self.library['album'] = new Object();
	self.library['track'] = new Object();
	self.library['item'] = new Object();
	self.library['index'] = new Object();

	self.libraryReadyDeferred = libQ.defer();
	self.libraryReady = self.libraryReadyDeferred.promise;

	var dbLibrary = libLevel(self.sLibraryPath, {'valueEncoding': 'json', 'createIfMissing': true});
	return self.commandRouter.getAllTracklists()
		.then(function(arrayAllTrackLists) {
			self.commandRouter.pushConsoleMessage('Populating library...');

			return libFast.map(arrayAllTrackLists, function(arrayTrackList) {
				return self.populateLibraryFromTracklist(arrayTrackList);
			});
		})
		.then(function() {
			self.commandRouter.pushConsoleMessage('  Genres: ' + Object.keys(self.library['genre']).length);
			self.commandRouter.pushConsoleMessage('  Artists: ' + Object.keys(self.library['artist']).length);
			self.commandRouter.pushConsoleMessage('  Albums: ' + Object.keys(self.library['album']).length);
			self.commandRouter.pushConsoleMessage('  Tracks: ' + Object.keys(self.library['track']).length);
			self.commandRouter.pushConsoleMessage('  Items: ' + Object.keys(self.library['item']).length);

			self.commandRouter.pushConsoleMessage('Generating indexes...');

			return libQ.all(libFast.map(self.arrayIndexDefinitions, function(curIndexDefinition) {
				return self.rebuildSingleIndex(curIndexDefinition);
			}));
		})
		.then(function() {
			self.commandRouter.pushConsoleMessage('Storing library in db...');

			return libQ.nfcall(libFast.bind(dbLibrary.put, dbLibrary), 'library', self.library);
		})
		.then(function() {
			self.commandRouter.pushConsoleMessage('Library rebuild complete.');

			try {
				self.libraryReadyDeferred.resolve();
			} catch (error) {
				self.pushError('Unable to resolve library promise: ' + error);
			}

			return libQ.resolve();
		})
		.fail(function(sError) {
			try {
				self.libraryReadyDeferred.reject(sError);
			} catch (error) {
				self.pushError('Unable to reject library promise: ' + error);
			}

			throw new Error('Library Rebuild Error: ' + sError);
		})
		.fin(libFast.bind(dbLibrary.close, dbLibrary));
}

// Internal methods ---------------------------------------------------------------------------

// Navigate through a source object via the provided path and retrieve a target object.
// The source object can the the entire library, or any sub-object.
// The path is a string with each field to navigate down separated by ':'.
// Use of '#' indicates that all Uids shown at that level are to be recursed down, and the result will be
// presented in an array. Using '#x' will pick out the Uid at index x, where x is a number.
// For example:
// getLibraryObject(self.library, 'track:XYZ:name') -> 'track XYZ name'
// getLibraryObject(self.library.album.ABC, 'parents:#:name') -> ['artist 1 name', 'artist 2 name']
// getLibraryObject(self.library.artist.DEF, 'parents:#0') -> <the object representing the first genre of artist DEF>
CoreMusicLibrary.prototype.getLibraryObject = function(objSource, sPath) {
	var self = this;

	if (sPath.indexOf(':') == -1) {
		try {
			return objSource[sPath];
		} catch (error) {
			throw new Error('getLibraryObject cannot navigate path: ' + sPath + '. Error: ' + error + '\nObject:\n' + libUtil.inspect(objSource, {depth: 2}));
		}
	}

	var curStep = sPath.slice(0, sPath.indexOf(':'));
	var sNewPath = sPath.slice(sPath.indexOf(':') + 1);

	if (curStep === '#') {
		return libFast.map(Object.keys(objSource), function(curUid) {
			return self.getLibraryObject(self.library, curUid + ':' + sNewPath);
		});
	} else if (curStep.substr(0,1) === '#') {
		return self.getLibraryObject(self.library, Object.keys(objSource)[curStep.substr(1)] + ':' + sNewPath);
	} else {
		var objCurStep = new Object();

		try {
			objCurStep = objSource[curStep];
		} catch (error) {
			throw new Error('getLibraryObject cannot navigate path: ' + curStep + '. Error: ' + error + '\nObject:\n' + libUtil.inspect(objSource, {depth: 2}));
		}

		return self.getLibraryObject(objCurStep, sNewPath);
	}
}

// Put the contents of a tracklist into the library
CoreMusicLibrary.prototype.populateLibraryFromTracklist = function(arrayTrackList) {
	var self = this;
	self.commandRouter.pushConsoleMessage('[' + Date.now() + '] ' + 'CoreMusicLibrary::populateLibraryFromTracklist');

	return libFast.map(arrayTrackList, function(curTrack) {
		return self.addLibraryItem(
			curTrack['service'],
			curTrack['uri'],
			curTrack['metadata']['title'],
			curTrack['metadata']['album'],
			curTrack['metadata']['artists'],
			curTrack['metadata']['genres'],
			curTrack['metadata']['tracknumber'],
			curTrack['metadata']['date']
		);
	});
}

// Create a single sorted index of a given music library table
CoreMusicLibrary.prototype.rebuildSingleIndex = function(objIndexDefinition) {
	var self = this;
	self.commandRouter.pushConsoleMessage('[' + Date.now() + '] ' + 'CoreMusicLibrary::rebuildSingleIndex');

	var sIndexName = objIndexDefinition['name'];
	var sTableName = objIndexDefinition['table'];
	var sSortBy = objIndexDefinition['sortby'];
	var objDataFields = objIndexDefinition['datafields'];

	if (!(sTableName in self.library)) {
		self.commandRouter.pushConsoleMessage('Specified table ' + sTableName + ' not found in library for indexing');
		return;
	}

	var arrayUids = libFast.map(Object.keys(self.library[sTableName]), function(curKey) {
		return sTableName + ':' + curKey;
	});

	return self.generateSortedIndex(arrayUids, sSortBy, objDataFields)
		.then(function(arraySortedIndex) {
			self.library.index[sIndexName] = arraySortedIndex;
		});
}

// Sort an array of UIDs based on a provided sort field. Returns a sorted array of UIDs, along with the fields which were specified to be stored.
CoreMusicLibrary.prototype.generateSortedIndex = function(arrayUids, sSortBy, objDataFields) {
	var self = this;

	return libQ.resolve()
		.then(function() {
			return libFast.map(arrayUids, function(curUid) {
				var curSortValue = flattenArrayToCSV(self.getLibraryObject(self.library, curUid + ':' + sSortBy));

				var curDataValue = new Object();
				libFast.map(Object.keys(objDataFields), function(curDataField) {
					curDataValue[curDataField] = flattenArrayToCSV(self.getLibraryObject(self.library, curUid + ':' + objDataFields[curDataField]));
				});

				return {'sortvalue': curSortValue, 'uid': curUid, 'datavalues': curDataValue};
			});
		})
		.then(function(arrayUnsorted) {
			// TODO - use a sort function which ignores prefixes "the", "a", etc., and case
			return libQ.fcall(libSortOn, arrayUnsorted, 'sortvalue');
		})
		.then(function(arraySorted) {
			return libFast.map(arraySorted, function(curEntry) {
				return {'uid': curEntry['uid'], 'datavalues': curEntry['datavalues']};
			});
		});
}

// Function to add an item to all tables in the database.
CoreMusicLibrary.prototype.addLibraryItem = function(sService, sUri, sTitle, sAlbum, arrayArtists, arrayGenres, nTrackNumber, dateTrackDate) {
	var self = this;

	var tableGenres = self.library['genre'];
	var tableArtists = self.library['artist'];
	var tableAlbums = self.library['album'];
	var tableTracks = self.library['track'];
	var tableItems = self.library['item'];

	curItemKey = convertStringToHashkey(sService + sUri);

	tableItems[curItemKey] = {
		id: curItemKey,
		type: 'item',
		service: sService,
		uri: sUri
	};

	tableItems[curItemKey]['children'] = new Object();
	tableItems[curItemKey]['parents'] = new Object();

	curTrackKey = convertStringToHashkey(sAlbum + sTitle);

	if (!(curTrackKey in tableTracks)) {
		tableTracks[curTrackKey] = new Object();
		tableTracks[curTrackKey] = new Object();
		tableTracks[curTrackKey]['name'] = sTitle;
		tableTracks[curTrackKey]['id'] = curTrackKey;
		tableTracks[curTrackKey]['type'] = 'track';
		tableTracks[curTrackKey]['tracknumber'] = nTrackNumber;
		tableTracks[curTrackKey]['date'] = dateTrackDate;
		tableTracks[curTrackKey]['children'] = new Object();
		tableTracks[curTrackKey]['parents'] = new Object();
	}

	tableTracks[curTrackKey]['children']['item:' + curItemKey] = null;
	tableItems[curItemKey]['parents']['track:' + curTrackKey] = null;

	if (sAlbum === 'Greatest Hits') {
		// The 'Greatest Hits' album name is a repeat offender for unrelated albums being grouped together.
		// If that is the album name, derive the key using a combination of the first artist and album name instead.
		curAlbumKey = convertStringToHashkey(arrayArtists[0] + sAlbum);
	} else {
		// Otherwise, tracks which share the same album name but not the same artist are probably actually
		// in the same album.
		curAlbumKey = convertStringToHashkey(sAlbum);
	}

	if (!(curAlbumKey in tableAlbums)) {
		tableAlbums[curAlbumKey] = new Object();
		tableAlbums[curAlbumKey] = new Object();
		tableAlbums[curAlbumKey]['name'] = sAlbum;
		tableAlbums[curAlbumKey]['id'] = curAlbumKey;
		tableAlbums[curAlbumKey]['type'] = 'album';
		tableAlbums[curAlbumKey]['children'] = new Object();
		tableAlbums[curAlbumKey]['parents'] = new Object();
	}

	tableAlbums[curAlbumKey]['children']['track:' + curTrackKey] = null;
	tableTracks[curTrackKey]['parents']['album:' + curAlbumKey] = null;

	for (var iArtist = 0; iArtist < arrayArtists.length; iArtist++) {
		curArtistKey = convertStringToHashkey(arrayArtists[iArtist]);

		if (!(curArtistKey in tableArtists)) {
			tableArtists[curArtistKey] = new Object();
			tableArtists[curArtistKey] = new Object();
			tableArtists[curArtistKey]['name'] = arrayArtists[iArtist];
			tableArtists[curArtistKey]['id'] = curArtistKey;
			tableArtists[curArtistKey]['type'] = 'artist';
			tableArtists[curArtistKey]['children'] = new Object();
			tableArtists[curArtistKey]['parents'] = new Object();
		}

		tableArtists[curArtistKey]['children']['album:' + curAlbumKey] = null;
		tableAlbums[curAlbumKey]['parents']['artist:' + curArtistKey] = null;

		for (var iGenre = 0; iGenre < arrayGenres.length; iGenre++) {
			curGenreKey = convertStringToHashkey(arrayGenres[iGenre]);

			if (!(curGenreKey in tableGenres)) {
				tableGenres[curGenreKey] = new Object();
				tableGenres[curGenreKey] = new Object();
				tableGenres[curGenreKey]['name'] = arrayGenres[iGenre];
				tableGenres[curGenreKey]['id'] = curGenreKey;
				tableGenres[curGenreKey]['type'] = 'genre';
				tableGenres[curGenreKey]['children'] = new Object();
				tableGenres[curGenreKey]['parents'] = new Object();
			}

			tableGenres[curGenreKey]['children']['artist:' + curArtistKey] = null;
			tableArtists[curArtistKey]['parents']['genre:' + curGenreKey] = null;
		}
	}

	return libQ.resolve();
}

// Pass the error if we don't want to handle it
// TODO calls to this function should instead be replaced by 'throw new Error()', which would be caught by
// any listening promise failure handler.
CoreMusicLibrary.prototype.pushError = function(sReason) {
	var self = this;
	self.commandRouter.pushConsoleMessage('[' + Date.now() + '] ' + 'CoreMusicLibrary::pushError(' + sReason + ')');

	// Return a resolved empty promise to represent completion
	return libQ.resolve();
}

// Helper functions ------------------------------------------------------------------------------------

// Create a URL safe hashkey for a given string. The result will be a constant length string containing
// upper and lower case letters, numbers, '-', and '_'.
function convertStringToHashkey(input) {
    if (input === null) {
        input = '';

    }

	return libBase64Url.escape(libCrypto.createHash('sha256').update(input, 'utf8').digest('base64'));
}

// Takes a nested array of strings and produces a comma-delmited string. Example:
// ['a', [['b', 'c'], 'd']] -> 'a, b, c, d'
function flattenArrayToCSV(arrayInput) {
	if (typeof arrayInput === "object") {
		return libFast.reduce(arrayInput, function(sReturn, curEntry, nIndex) {
			if (nIndex > 0) {
				return sReturn + ", " + flattenArrayToCSV(curEntry);
			} else {
				return flattenArrayToCSV(curEntry);
			}
		},"");
	} else {
		return arrayInput;
	}
}

