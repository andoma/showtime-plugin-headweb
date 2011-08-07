/*
 *  Headweb plugin
 *
 *  API docs available here: http://opensource.headweb.com/api
 *
 *  Copyright (C) 2010 Andreas Öman
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

  plugin.createService("Headweb", PREFIX + "start", "video", true,
		       plugin.path + "headweb_square.png");

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

  function bestCover(content) {
    var best = null;
    var bestArea = 0;
    for each (var c in content.cover) {
      var a = c.@width * c.@height;
      if(a > bestArea) {
	best = c;
	bestArea = a;
      }
    }
    return best;
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
	  icon: bestCover(c),
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

    var response = request("/user/rentals", 0, 200);

    for each (var item in response.list.item) {
      if (item.@id == id && item.state != 'expired')
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








  // List all genres
  plugin.addURI(PREFIX + "genres", function(page) {
    page.metadata.title = "Genres";
    page.metadata.logo = plugin.path + "headweb_square.png";
    page.type = "directory";

    var doc = request("/genre/filter(-adult,stream)");

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
    requestContents(page, "/genre/" + id + "/filter(-adult,stream)");
  });


  // Play a stream
  plugin.addURI(PREFIX + "stream:([0-9]*)", function(page, id) {

    var doc = request("/stream/" + id);

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
    page.metadata.icon = bestCover(doc.content);

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
      rentButton.enabled = !available;
    }
  });

  // Start page
  plugin.addURI(PREFIX + "start", function(page) {

    page.appendItem("headweb:watchlist", "directory", {
      title: "My watchlist",
      subtype: "favourites"
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
