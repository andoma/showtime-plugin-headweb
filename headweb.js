/*
 *  Headweb plugin for Movian Media Center
 *
 *  API docs available here: http://opensource.headweb.com/api
 *
 *  Copyright (C) 2010-2015 Andreas Öman
 *  Copyright (C) 2012 Henrik Andersson
 *
 *  This program is free software: you can redistribute it and/or modify
 *  it under the terms of the GNU General Public License as published by
 *  the Free Software Foundation, either version 3 of the License, or
 *  (at your option) any later version.
 *
 *  This program is distributed in the hope that it will be useful,
 *  but WITHOUT ANY WARRANTY; without even the implied warranty of
 *  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *  GNU General Public License for more details.
 *
 *  You should have received a copy of the GNU General Public License
 *  along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

var XML = require('showtime/xml');


(function(plugin) {
  var PREFIX = "headweb:"

  var loggedIn = false;

  var service = plugin.createService("Headweb", PREFIX + "start", "video", true,
				     plugin.path + "headweb_square.png");

  var settings = plugin.createSettings("Headweb", plugin.path + "headweb_square.png",
				       "Headweb: Online video");
  settings.createBool("noadult", "Hide adult content", true, function(v) {
      service.noadult = v;
  });

  /**
   * Headweb API KEY.
   * Please don't steal Showtime's key..
   * Send an email to api@headweb.com and you'll get your own for free,
   */
  var APIKEY = "2d6461dd322b4b84b5bac8c654ee6195";


  /**
   *
   */
  function code2lang(code) {
    var langmap = {
      sv: 'swe',
      fi: 'fin',
      no: 'nor',
      da: 'dan'
    }
    if(code in langmap)
      return langmap[code];
    showtime.trace('Need language mapping for: ' + code);
    return null;
  }



  /*
   * Login user
   * The headweb session is handled via standard HTTP cookies.
   * This is taken care of by Showtime's HTTP client.
   * If 'query' is set we will ask user for username/password
   * otherwise we just try to login using the credentials stored in 
   * Showtime's keyring.
   *
   */

  function login(query) {

    if(loggedIn)
      return false;

    var reason = "Login required";
    var do_query = false;

    while(1) {

      var credentials = plugin.getAuthCredentials("Headweb streaming service",
	reason, do_query);
    
      if(!credentials) {
	if(query && !do_query) {
	  do_query = true;
	  continue;
	}
	return "No credentials";
      }

      if(credentials.rejected)
	return "Rejected by user";

      var v = showtime.httpReq("https://api.headweb.com/v4/user/login", {

        postdata: {
	  username: credentials.username,
	  password: credentials.password
        },

        args: {
	  apikey: APIKEY
        }
      });

      var doc = XML.parse(v).response;
      if(doc.error) {
	reason = doc.error;
	do_query = true;
	continue;
      }
      showtime.trace('Logged in to Headweb as user: ' + credentials.username);
      loggedIn = true;
      return false;
    }
  }


  function request(path, offset, limit) {
    var v = showtime.httpReq("https://api.headweb.com/v4" + path, {
      args: {
        apikey: APIKEY,
        offset: offset,
        limit: limit
      }
    });
    return XML.parse(v).response;
  }


  function asyncRequest(path, offset, limit, callback) {
    var v = showtime.httpReq("https://api.headweb.com/v4" + path, {
      args: {
        apikey: APIKEY,
        offset: offset,
        limit: limit
      }
    }, function(err, response) {
      if(err) {
        callback(null);
      } else {
        var doc;
        try {
          doc = XML.parse(response).response;
        } catch(e) {
          callback(null);
          return;
        }
        callback(doc);
      }
    });
  }

  function imageSet(covers) {
    var images = [];
    for(var i = 0; i < covers.length; i++) {
      var c = covers[i];
      images.push({
	width: parseInt(c["@width"]),
	height: parseInt(c["@height"]),
	url: c.toString()});
    }
    return "imageset:" + showtime.JSONEncode(images);
  }


  function bestTrailer(content) {
    var best = null;
    var bestRate = 0;

    if(!content.videoclip)
      return null;

    var bitrates = content.videoclip.filterNodes('bitrate');
    for (var i = 0; i < bitrates.length; i++) {
      var c = bitrates[i];
      var rate = parseInt(c["@rate"]);
      if(rate > bestRate) {
	best = c.url;
	bestRate = rate;
      }
    }
    return best;
  }

  function bestStream(content) {
    return content.stream;
  }


  function merge(doc, name) {
    return doc.filterNodes(name).join(", ");
  }

  function addContentToPage(page, content) {
    var stream = bestStream(content);
    var metadata = {
      title: content.name,
      icon: imageSet(content.filterNodes('cover')),
      description: new showtime.RichText(content.plot),
      rating: parseFloat(content.rating) * 20
    };

    var runtime = parseInt(stream.runtime);
    if(runtime > 0)
      metadata.runtime = runtime;

    page.appendItem(PREFIX + "video:" + stream["@id"],
		    "video", metadata);
  }

  function requestRentals(page) {
    var offset = 0;
    if(login(false))
      return;

    function loader() {
      var doc = request("/user/rentals/active", offset, 50);
      if(!doc.list)
        return false;

      page.entries = parseInt(doc.list["@items"]);

      for(var i = 0; i < doc.list.length; i++) {
        var item = doc.list[i];
        offset++;
	var contentIdURI = "/content/" + (parseInt(item["@id"])+1);
        try {
	  var ldoc = request(contentIdURI, 0, 50);
	  addContentToPage(page, ldoc.content);
        } catch(e) {
          console.log("Unable to add " + contentIdURI + " -- " + e);
        }

      }
      return offset < page.entries;
    }

    page.type = "directory";
    loader();
    page.loading = false;
    page.paginator = loader;
  }

  function requestContents(page, url) {
    var offset = 0;

    function loader() {
      asyncRequest(url, offset, 50, function(doc) {
        page.loading = false;
        if(!doc.list) {
          page.haveMore(false);
          return;
        }

        page.entries = parseInt(doc.list["@items"]);
        for (var i = 0; i < doc.list.length; i++) {
          var c = doc.list[i];
	  offset++;
	  addContentToPage(page, c);
        }
        page.haveMore(offset < page.entries);
      });
    }

    page.type = "directory";
    page.paginator = loader;
    loader();
  }


  function isRented(id) {
    if(login(false))
      return false;

    var response = request("/user/rentals/active", 0, 200);
    var items = response.list.filterNodes('item');
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if(item["@id"] == id)
	return true;
    }

    return false;
  }


  function rent(item, rawprice, title, price) {
    if(login(true))
      return false;

    if(!showtime.message('<center>Are you sure want to rent<br><b>' + title + '</b><br>For ' +
			 price, true, true))
      return false;

    var v = showtime.httpReq("https://api.headweb.com/v4/purchase/0", {
      args: {
        apikey: APIKEY,
        payment: 'account',
        item: item,
        total: rawprice
      }
    })

    var response = XML.parse(v).response;
    response.dump();
    if(response.purchase.failed) {
      showtime.message('Rentail failed:\n' + response.purchase.failed,
		       true, false);
      return false;
    }

    return true;
  }

  function getPersons(doc, type) {
    var items = doc.filterNodes(type);
    var actors = [];

    for(var i = 0; i < items.length; i++) {
      actors.push(items[i].person.toString());
    }
    return actors.join(", ");
  }


  function getFilter() {
    var filter = "stream[flash]";
    if (service.noadult)
	filter += ",-adult";
    return filter;
  }

  // Latests additions
  plugin.addURI(PREFIX + "latest", function(page) {
    page.loading = true;
    page.metadata.title = "Latest";
    page.metadata.logo = plugin.path + "headweb_square.png";
    page.type = "directory";
    requestContents(page, "/content/latest/filter(" + getFilter() + ")");
    page.loading = false;
  });

  // Active Rentals
  plugin.addURI(PREFIX + "rentals", function(page) {
    page.loading = true;
    page.metadata.title = "Active rentals";
    page.metadata.logo = plugin.path + "headweb_square.png";
    page.type = "directory";
    requestRentals(page);
    page.loading = false;
  });

  // Top rated
  plugin.addURI(PREFIX + "toprated", function(page) {
    page.loading = true;
    page.metadata.title = "Top rated";
    page.metadata.logo = plugin.path + "headweb_square.png";
    page.type = "directory";
    requestContents(page, "/content/toprate/filter(" + getFilter() + ")");
    page.loading = false;
  });

  // Top rated
  plugin.addURI(PREFIX + "bestsell", function(page) {
    page.loading = true;
    page.metadata.title = "Best sellers";
    page.metadata.logo = plugin.path + "headweb_square.png";
    page.type = "directory";
    requestContents(page, "/content/bestsell/filter(" + getFilter() + ")");
    page.loading = false;
  });

  // List all genres
  plugin.addURI(PREFIX + "genres", function(page) {
    page.loading = true;
    page.metadata.title = "Genres";
    page.metadata.logo = plugin.path + "headweb_square.png";
    page.type = "directory";

    var doc = request("/genre/filter(" + getFilter() + ")");

    var genres = doc.list.filterNodes('genre');

    for(var i = 0; i < genres.length; i++) {
      var genre = genres[i];
      page.appendItem(PREFIX + "genre:" + genre["@id"] + ":" + genre,
		      "directory", {
			title:genre.toString()
		      });
    }
    page.loading = false;
  });


  // Browse a genre
  plugin.addURI(PREFIX + "genre:([0-9]*):(.*)", function(page, id, name) {
    page.loading = true;
    page.metadata.title = name;
    page.metadata.logo = plugin.path + "headweb_square.png";
    requestContents(page, "/genre/" + id + "/filter(" + getFilter() + ")");
    page.loading = false;
  });


  // Play a stream
  plugin.addURI(PREFIX + "stream:([0-9]*)", function(page, id) {
    page.loading = true;
    var v = showtime.httpGet("https://api.headweb.com/v4/stream/" + id, {
      apikey: APIKEY,
      authmode: 'player' // should be changed to 'row'
    });
    var doc = XML.parse(v.toString()).response;
    // Construct dict with subtitle URLs

    var subtitles = []
    if (doc.error) {
      page.error(doc.error);
      return;
    }
    var xmlsubs = doc.content.stream.filterNodes('subtitle');
    for (var i = 0; i < xmlsubs.length; i++) {
      var sub = xmlsubs[i];

      subtitles.push({
	url: sub.url,
	language: code2lang(sub.language["@code"])
      });
    }

    var params = showtime.queryStringSplit(doc.auth.playerparams);
    var rtmpurl = params["cfg.stream.auth.url"] + "/" +
      params["cfg.stream.auth.streamid"];

    page.loading = false;

    page.source = "videoparams:" + showtime.JSONEncode({
      title: doc.content.name,
      subtitles: subtitles,
      canonicalUrl: PREFIX + "stream:" + id,
      sources: [{
	url: rtmpurl
      }]
    });
    page.type = "video";
    page.loading = false;
  });


  // Video launch
  plugin.addURI(PREFIX + "video:([0-9]*)", function(page, id) {
    page.loading = true; 
    var doc = request("/stream/" + id);
    if(doc.error) {
      page.error(doc.error);
      return;
    }

    page.metadata.title = doc.content.name + ' (' + doc.content.year + ')';
    page.metadata.icon = imageSet(doc.content.filterNodes('cover'));

    page.appendPassiveItem("label", merge(doc.content, 'genre'))
    page.appendPassiveItem("rating", parseFloat(doc.content.rating) / 5.0);

    page.appendPassiveItem("divider")

    var d = parseFloat(doc.content.stream.runtime);
    if(d > 0)
      page.appendPassiveItem("label", showtime.durationToString(d), {
	title: 'Duration'});

    page.appendPassiveItem("label", merge(doc.content, 'year'), {
      title: 'Year'
    });

    page.appendPassiveItem("label", getPersons(doc.content, 'actor'), {
      title: 'Actors'
    });

    page.appendPassiveItem("label", getPersons(doc.content, 'director'), {
      title: 'Director'
    });

    page.appendPassiveItem("divider")

    page.appendPassiveItem("bodytext", new showtime.RichText(doc.content.plot));

    var trailerURL = bestTrailer(doc.content);
    var stream = bestStream(doc.content);

    if(trailerURL) {
      trailerURL = "videoparams:" + showtime.JSONEncode({
            title: doc.content.name + ' - Trailer',
            sources: [{
                url: trailerURL
            }],
            no_subtitle_scan: true
        });

      page.appendAction("navopen", trailerURL, true, {
	title: "Watch trailer"
      });
    }

    page.appendAction("navopen", PREFIX + "stream:" + id, true, {
      title: "Watch movie"
    });


    var rentButton = page.appendAction("pageevent", "rent", false, {
      title: "Rent movie (" + stream.price + ")"
    });

    page.loading = false;
    page.type = "item";


    page.onEvent('rent', function() {
      setMovieStatus(rent(stream["@id"], stream.price["@raw"],
			 doc.content.name, stream.price));
    });

    setMovieStatus(isRented(stream["@id"]));

    function setMovieStatus(isRented) {
      if (isRented)
	rentButton.disable();
      else
	rentButton.enable();
    }
    page.loading = false;
  });

  // Start page
  plugin.addURI(PREFIX + "start", function(page) {
    page.loading = true;
    page.appendItem("headweb:watchlist", "directory", {
      title: "My watchlist",
      subtype: "favourites"
    });

    page.appendItem("headweb:rentals", "directory", {
      title: "Active Rentals"
    });

    page.appendItem("headweb:latest", "directory", {
      title: "Latest additions"
    });

    page.appendItem("headweb:toprated", "directory", {
      title: "Top rated"
    });

    page.appendItem("headweb:bestsell", "directory", {
      title: "Best sellers"
    });

    page.appendItem("headweb:genres", "directory", {
      title: "Genres",
      subtype: "genres"
    });

    page.type = "directory";
    page.contents = "items";
    page.loading = false;
    page.metadata.logo = plugin.path + "headweb_square.png";
    page.metadata.title = "Headweb";
  });

  // Watchlist
  plugin.addURI(PREFIX + "watchlist", function(page) {
    var v = login(true);
    if(v) {
      page.error(v);
      return;
    }
    page.metadata.title = "My watchlist";
    page.metadata.logo = plugin.path + "headweb_square.png";
    requestContents(page, "/user/watchlist");
  });

  // Search hook
  plugin.addSearcher("Headweb movies", plugin.path + "headweb_icon.png",
    function(page, query) {
      requestContents(page, "/search/" + showtime.paramEscape(query));
    });

})(this);
