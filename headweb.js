/*
 *  Headweb plugin
 *
 *  API docs available here: http://opensource.headweb.com/api
 *
 *  Copyright (C) 2010 Andreas Öman
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

      var v = showtime.httpPost("https://api.headweb.com/v4/user/login", {
	username: credentials.username,
	password: credentials.password
      }, {
	apikey: APIKEY
      });
      
      var doc = new XML(v.toString());
      
      if(doc.error.length()) {
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
    var v = showtime.httpGet("https://api.headweb.com/v4" + path, {
      apikey: APIKEY,
      offset: offset,
      limit: limit
    });
    return new XML(v.toString());
  }

  function imageSet(content) {
    var images = [];
    for each (var c in content.cover) {
      images.push({
	width: parseInt(c.@width),
	height: parseInt(c.@height),
	url: c});
    }
    return "imageset:" + showtime.JSONEncode(images);
  }


  function bestTrailer(content) {
    var best = null;
    var bestRate = 0;
    for each (var c in content.videoclip.bitrate) {
      if(c.@rate > bestRate) {
	best = c.url;
	bestRate = c.@rate;
      }
    }
    return best;
  }

  function bestStream(content) {
    return content.stream;
  }


  function merge(list) {
    var prefix = "";
    var r = "";
    for each (v in list) {
      r += prefix + v;
      prefix = ", ";
    }
    return r;
  }



  function requestContents(page, url) {
    var offset = 0;


    function loader() {
      var doc = request(url, offset, 50);
      page.entries = doc.list.@items;
      for each (var c in doc.list.content) {
	offset++;
	var stream = bestStream(c);

	var metadata = {
	  title: c.name,
	  icon: imageSet(c),
	  description: new showtime.RichText(c.plot),
	  rating: parseFloat(c.rating) / 5.0
	};

	var runtime = parseInt(stream.runtime);
	if(runtime > 0) 
	  metadata.runtime = runtime;
	
	page.appendItem(PREFIX + "video:" + stream.@id,
			"video", metadata);
      }
      return offset < page.entries;
    }

    page.type = "directory";
    loader();
    page.loading = false;
    page.paginator = loader;
  }


  function isRented(id) {
    if(login(false))
      return false;

    var response = request("/user/rentals/active", 0, 200);

    for each (var item in response.list.item) {
      if (item.@id == id)
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

    var v = showtime.httpGet("https://api.headweb.com/v4/purchase/0", {
      apikey: APIKEY,
      payment: 'account',
      item: item,
      total: rawprice})

    var response = new XML(v.toString());

    if(response.purchase.failed.length()) {
      showtime.message('Rentail failed:\n' + response.purchase.failed,
		       true, false);
      return false;
    }

    return true;
  }

  function getFilter() {
    var filter = "stream";
    if (service.noadult)
	filter += ",-adult";
    return filter;
  }

  // Latests additions
  plugin.addURI(PREFIX + "latest", function(page) {
    page.metadata.title = "Latest";
    page.metadata.logo = plugin.path + "headweb_square.png";
    page.type = "directory";
    requestContents(page, "/content/latest/filter(" + getFilter() + ")");
    page.loading = false;
  });

  // Top rated
  plugin.addURI(PREFIX + "toprated", function(page) {
    page.metadata.title = "Top rated";
    page.metadata.logo = plugin.path + "headweb_square.png";
    page.type = "directory";
    requestContents(page, "/content/toprate/filter(" + getFilter() + ")");
    page.loading = false;
  });

  // Top rated
  plugin.addURI(PREFIX + "bestsell", function(page) {
    page.metadata.title = "Best sellers";
    page.metadata.logo = plugin.path + "headweb_square.png";
    page.type = "directory";
    requestContents(page, "/content/bestsell/filter(" + getFilter() + ")");
    page.loading = false;
  });

  // List all genres
  plugin.addURI(PREFIX + "genres", function(page) {
    page.metadata.title = "Genres";
    page.metadata.logo = plugin.path + "headweb_square.png";
    page.type = "directory";

    var doc = request("/genre/filter(" + getFilter() + ")");

    for each (var genre in doc.list.genre) {
      page.appendItem(PREFIX + "genre:" + genre.@id + ":" + genre,
		      "directory", {
			title:genre
		      });
    }
    page.loading = false;
  });


  // Browse a genre
  plugin.addURI(PREFIX + "genre:([0-9]*):(.*)", function(page, id, name) {
    page.metadata.title = name;
    page.metadata.logo = plugin.path + "headweb_square.png";
    requestContents(page, "/genre/" + id + "/filter(" + getFilter() + ")");
  });


  // Play a stream
  plugin.addURI(PREFIX + "stream:([0-9]*)", function(page, id) {

    var v = showtime.httpGet("https://api.headweb.com/v4/stream/" + id, {
      apikey: APIKEY,
      authmode: 'player' // should be changed to 'row'
    });
    var doc = new XML(v.toString());

    // Construct dict with subtitle URLs

    var subtitles = []

    for each (var sub in doc.content.stream.subtitle) {
      subtitles.push({
	url: sub.url,
	language: code2lang(sub.language.@code)
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
  });


  // Video launch
  plugin.addURI(PREFIX + "video:([0-9]*)", function(page, id) {
 
    var doc = request("/stream/" + id);
    if(doc.error.length()) {
      page.error(doc.error);
      return;
    }

    page.metadata.title = doc.content.name + ' (' + doc.content.year + ')';
    page.metadata.icon = imageSet(doc.content);

    page.appendPassiveItem("label", merge(doc.content.genre))
    page.appendPassiveItem("rating", parseFloat(doc.content.rating) / 5.0);

    page.appendPassiveItem("divider")

    var d = parseFloat(doc.content.stream.runtime);
    if(d > 0)
      page.appendPassiveItem("label", showtime.durationToString(d), {
	title: 'Duration'});

    page.appendPassiveItem("label", merge(doc.content.actor.person), {
      title: 'Actors'
    });

    page.appendPassiveItem("label", merge(doc.content.director.person), {
      title: 'Director'
    });

    page.appendPassiveItem("divider")

    page.appendPassiveItem("bodytext", new showtime.RichText(doc.content.plot));


    var trailerURL = bestTrailer(doc.content);
    var stream = bestStream(doc.content);

    if(trailerURL) {
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
      setMovieStatus(rent(stream.@id, stream.price.@raw,
			 doc.content.name, stream.price));
    });
    
    setMovieStatus(isRented(stream.@id));

    function setMovieStatus(available) {
      if (available)
	  rentButton.disable();
      else
	  rentButton.enable();
    }
  });

  // Start page
  plugin.addURI(PREFIX + "start", function(page) {

    page.appendItem("headweb:watchlist", "directory", {
      title: "My watchlist",
      subtype: "favourites"
    });

    page.appendItem("headweb:latest", "directory", {
      title: "Latest additions"});

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
  plugin.addSearcher(
    "Headweb movies", plugin.path + "headweb_icon.png",
    function(page, query) {
      requestContents(page, "/search/" + showtime.paramEscape(query));
    });

})(this);
