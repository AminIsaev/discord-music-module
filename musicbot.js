const ytdl = require('ytdl-core');
const ytSearch = require('youtube-search');
const MongoClient = require('mongodb').MongoClient;

var voice = {};                  // voice connections list (key: channelID, value: voiceConnection object)
var voiceConnections = {};       // voice connection objects
var voiceDispatchers = {};       // stream dispatcher objects
var voiceIntervals = {};         // intervals for automatic disconnect

class Musicbot {
    constructor(mongoConnection, bot, ytKey) {
      this.maxQueueStringLength = 50;                        // maximum length of one queue line
      this.bot = bot;                                        // discord client
      this.youtubeOptions = {maxResults: 10, key: ytKey};    // youtube search api options object
      this.db = new DB(mongoConnection);                     // mongo connection
      this.playlist = new Playlist(this.bot, this.db);       // playlist object
    }
    // Description - Shuffles array in place.
    shuffleArray(array) {
      for (let i = array.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [array[i], array[j]] = [array[j], array[i]];
      }
    }
    // Description - Seconds to time string.
    secToString(sec) {
      var sec_num = parseInt(sec, 10);
      var hours   = Math.floor(sec_num / 3600);
      var minutes = Math.floor((sec_num - (hours * 3600)) / 60);
      var seconds = sec_num - (hours * 3600) - (minutes * 60);
  
      if (hours   < 10) {hours   = "0"+hours;}
      if (minutes < 10) {minutes = "0"+minutes;}
      if (seconds < 10) {seconds = "0"+seconds;}
      return hours+':'+minutes+':'+seconds;
    }
    // Description - Checks if input is valid youtube URL, if not searches youtube for input as query.
    getSongURL(text) {
      return new Promise(async (resolve, reject) => {
        let info;
        try {
          info = await ytdl.getInfo(text);
        } catch (e) {
          try {
            let res = await ytSearch(text, this.youtubeOptions);
            info = await ytdl.getInfo(res.results[0].link);
          } catch (e) {
            return resolve(false)
          }
        }
        return resolve(info)
      })
    }
    // Description - Main music bot flow control function
    //    cid - channel id
    //    seek - starting time in seconds
    playNext(cid, seek = 0) {
      let stream = ytdl(voice[cid].playlist[voice[cid].currentSong].url, {filter: 'audioonly'});
      voiceDispatchers[cid] = voiceConnections[cid].playStream(stream, {seek: seek});
      voice[cid].seek = seek;
  
      voiceDispatchers[cid].on('end', async (e) => {
        voiceDispatchers[cid] = false;
        switch (e) {
          case 'stop':
            voice[cid].currentSong = 0;
            this.db.updateDB();
            break;
          case 'previous':
              voice[cid].currentSong--;
              if ( voice[cid].currentSong < 0 ) {
                if ( voice[cid].loop ) {
                  voice[cid].currentSong = voice[cid].playlist.length - 1;
                } else {
                  voice[cid].currentSong = 0;
                }
              }
              this.db.updateDB();
              this.playNext(cid);  
            break;
          default:
            if ( voice[cid].autoplay ) {
              let info = await this.getSongURL(voice[cid].playlist[voice[cid].currentSong].url);
              let nextInfo = false;
              let i = 0;
              while ( i != info.related_videos.length ) {
                try {
                  if ( 'id' in info.related_videos[i] ) {
                    nextInfo = await ytdl.getInfo('https://www.youtube.com/watch?v=' + info.related_videos[i].id);
                  } else if ( 'video_id' in info.related_videos[0] ) {
                    nextInfo = await ytdl.getInfo('https://www.youtube.com/watch?v=' + info.related_videos[i].video_id);
                  } 
                  for ( let j = 0; j < voice[cid].playlist.length; j++ ) {
                    if ( voice[cid].playlist[j].url === nextInfo.video_url ) throw('Already in queue.');
                  }
                  voice[cid].playlist.push({title: nextInfo.title, url: nextInfo.video_url, duration: nextInfo.length_seconds, thumb: nextInfo.thumbnail_url, owner: this.bot.user.username});
                  break;
                } catch (e) {
                  i++;
                }
              }
            }
            if ( e == 'next' || !voice[cid].loop1 ) voice[cid].currentSong++;
            if ( voice[cid].currentSong == voice[cid].playlist.length) {
              voice[cid].currentSong = 0;
              this.db.updateDB();
              if ( voice[cid].loop ) this.playNext(cid);
            } else {
              this.playNext(cid);
            }
        }
      });
    }
  
    // description - joins a voice channel
    async join(vc) {
      return new Promise(async (resolve, reject) => {
        if (!vc) return resolve({success: false, message: "You need to join a voice channel first (invalid voice channel)."});
        if (vc.id in voiceConnections && voiceConnections[vc.id] ) return resolve({success: false, message: "Already connected."});
        
        if (!(vc.id in voiceConnections)) voiceConnections[vc.id] = false;
        if (!(vc.id in voiceDispatchers)) voiceDispatchers[vc.id] = false;
        if (!(vc.id in voice)) voice[vc.id] = {seek: 0, playlist: [], currentSong: 0, loop: false, loop1: false, shuffle: [], saved: [], search: false, pause: false, autoplay: false};
    
        voice[vc.id].seek = 0;
        voice[vc.id].autoplay = false;
        voiceConnections[vc.id] = await vc.join();
    
        let channel = vc.id;
        if (!(vc.id in voiceIntervals)) {
          voiceIntervals[vc.id] = setInterval(() => {
            if ( voiceConnections[channel].channel.members.array().length == 1 ) {
              if ( voiceDispatchers[channel] ) voiceDispatchers[channel].end('dc');
              voiceConnections[channel].disconnect();
              voiceConnections[channel] = false;
            }
          }, 30000);
        }
    
        this.db.updateDB();
        return resolve({success: true, message: "Joined " + vc.name + "."});
      })
    }
    // description - plays a song with autoplay ON
    //    argv - youtube url or search string
    //    owner - message author username
    async autoplay(vc, argv, owner) {
      return new Promise(async (resolve, reject) => {
        if (!vc) return resolve({success: false, message: "You need to join a voice channel first (invalid voice channel)."});
        argv = argv.join(',').split(' ');
    
        if ( argv.length > 0 && argv[0] != '' ) {
          if ( isNaN(parseInt(argv[0])) || argv.length > 1 ) {
            let info = await this.getSongURL(argv.join(" "));
            if ( info === false ) return resolve({success: false, message: "Invalid query."});
    
            if (!(vc.id in voiceConnections)) voiceConnections[vc.id] = false;
            if (!(vc.id in voiceDispatchers)) voiceDispatchers[vc.id] = false;
            if (!(vc.id in voice)) voice[vc.id] = {seek: 0, playlist: [], currentSong: 0, loop: false, loop1: false, shuffle: [], saved: [], search: false, pause: false, autoplay: true};
    
            if ( !voiceConnections[vc.id] ) {
              voiceConnections[vc.id] = await vc.join();
            }
    
            voice[vc.id].seek = 0;
    
            let channel = vc.id;
            if (!(vc.id in voiceIntervals)) {
              voiceIntervals[vc.id] = setInterval(() => {
                if ( voiceConnections[channel].channel.members.array().length == 1 ) {
                  if ( voiceDispatchers[channel] ) voiceDispatchers[channel].end('dc');
                  voiceConnections[channel].disconnect();
                  voiceConnections[channel] = false;
                }
              }, 30000);
            }
    
            voice[vc.id].playlist = [{title: info.title, url: info.video_url, duration: info.length_seconds, thumb: info.thumbnail_url, owner: owner}];
            voice[vc.id].currentSong = 0;
            voice[vc.id].shuffle = [];
            voice[vc.id].loop = false;
            voice[vc.id].autoplay = true;
            this.playNext(vc.id);
    
          } else {
            if ( parseInt(argv[0]) > voice[vc.id].playlist.length || parseInt(argv[0]) < 1 ) return resolve({success: false, message: "Invalid index."});
            if ( voiceDispatchers[vc.id] ) voiceDispatchers[vc.id].end('stop');
            voice[vc.id].playlist = [voice[vc.id].playlist[parseInt(argv[0]) - 1]];
            voice[vc.id].currentSong = 0;
            voice[vc.id].seek = 0;
            voice[vc.id].shuffle = [];
            voice[vc.id].loop = false;
            voice[vc.id].autoplay = true;
            this.playNext(vc.id);
          }
    
        } else if ( voice[vc.id].playlist.length != 0 ) {
          voice[vc.id].playlist = [voice[vc.id].playlist[voice[vc.id].currentSong]];
          voice[vc.id].currentSong = 0;
          voice[vc.id].seek = 0;
          voice[vc.id].shuffle = [];
          voice[vc.id].loop = false;
          voice[vc.id].autoplay = true;
          if ( vc.id in voiceDispatchers && voiceDispatchers[vc.id] && voiceDispatchers[vc.id].paused ) {
            voiceDispatchers[vc.id].resume();
          } else if ( !voiceDispatchers[vc.id] ) {
            this.playNext(vc.id);
          }
        }
        this.db.updateDB();
        return resolve({success: true, message: "Autoplaying " + voice[vc.id].playlist[voice[vc.id].currentSong].title + "."});
      })
    }
    // description - plays a song 
    //    argv - youtube url or search string
    //    owner - message author username
    async play(vc, argv, owner) {
      return new Promise(async (resolve, reject) => {
        if (!vc) return resolve({success: false, message: "You need to join a voice channel first (invalid voice channel)."});
        argv = argv.join(',').split(' ');
        let message = "";
        
        if ( argv.length > 0 && argv[0] != '' ) {
          if ( isNaN(parseInt(argv[0])) || argv.length > 1 ) {
            let info = await this.getSongURL(argv.join(" "));
            if ( info === false ) return resolve({success: false, message: "Invalid query."});
    
            if (!(vc.id in voiceConnections)) voiceConnections[vc.id] = false;
            if (!(vc.id in voiceDispatchers)) voiceDispatchers[vc.id] = false;
            if (!(vc.id in voice)) voice[vc.id] = {seek: 0, playlist: [], currentSong: 0, loop: false, loop1: false, shuffle: [], saved: [], search: false, pause: false, autoplay: false};
            
            for ( let i = 0; i < voice[vc.id].playlist.length; i++ ) {
              if ( info.video_url == voice[vc.id].playlist[i].url ) {
                if ( !voiceDispatchers[vc.id] ) {
                  voice[vc.id].currentSong = i;
                  this.playNext(vc.id);
                  return;
                } else {
                  return resolve({success: false, message: "Already in queue."});
                }
              }
            }
    
            voice[vc.id].autoplay = false;
            voice[vc.id].seek = 0;
    
            if ( !voiceConnections[vc.id] ) {
              voiceConnections[vc.id] = await vc.join();
            }
    
            let channel = vc.id;
            if (!(vc.id in voiceIntervals)) {
              voiceIntervals[vc.id] = setInterval(() => {
                if ( voiceConnections[channel].channel.members.array().length == 1 ) {
                  if ( voiceDispatchers[channel] ) voiceDispatchers[channel].end('dc');
                  voiceConnections[channel].disconnect();
                  voiceConnections[channel] = false;
                }
              }, 30000);
            }
    
            if ( voice[vc.id].shuffle.length == 0 ) {
              voice[vc.id].playlist.push({title: info.title, url: info.video_url, duration: info.length_seconds, thumb: info.thumbnail_url, owner: owner});
            } else {
              voice[vc.id].playlist.splice(Math.floor(Math.random() * (voice[vc.id].playlist.length - voice[vc.id].currentSong + 1)) + voice[vc.id].currentSong + 1, 0, {title: info.title, url: info.video_url, duration: info.length_seconds, thumb: info.thumbnail_url, owner: owner});
              voice[vc.id].shuffle.push({title: info.title, url: info.video_url, duration: info.length_seconds, thumb: info.thumbnail_url, owner: owner});
            }
            if ( !voiceDispatchers[vc.id] ) {
              voice[vc.id].currentSong = voice[vc.id].playlist.length - 1;
              this.playNext(vc.id);
              message = "Playing " + voice[vc.id].playlist[voice[vc.id].currentSong].title + ".";
            } else {
              message = "Enqueued " + info.title + ".";
            }
            
          } else {
            if ( parseInt(argv[0]) > voice[vc.id].playlist.length || parseInt(argv[0]) < 1 ) return resolve({success: false, message: "Invalid index."});
            if ( voiceDispatchers[vc.id] ) voiceDispatchers[vc.id].end('stop');
            voice[vc.id].currentSong = parseInt(argv[0]) - 1;
            voice[vc.id].seek = 0;
            this.playNext(vc.id);
            message = "Playing " + voice[vc.id].playlist[voice[vc.id].currentSong].title + ".";
          }
        } else {
          if ( vc.id in voiceDispatchers && voiceDispatchers[vc.id] && voiceDispatchers[vc.id].paused ) {
            voiceDispatchers[vc.id].resume();
            message = "Resumed.";
          } else if ( vc.id in voice && !voiceDispatchers[vc.id] && voice[vc.id].playlist.length != 0 ) {
            if ( !voiceConnections[vc.id] ) {
              voiceConnections[vc.id] = await vc.join();
            }
            voice[vc.id].seek = 0;
            voice[vc.id].currentSong = 0;
            this.playNext(vc.id);
            message = "Playing " + voice[vc.id].playlist[voice[vc.id].currentSong].title + ".";
          }
        }
        this.db.updateDB();
        return resolve({success: true, message: message});
      })
    }
    // description - leaves a voice channel
    leave(vc) {
      if (!vc) return {success: false, message: "You need to join a voice channel first (invalid voice channel)."};
      if (!(vc.id in voiceConnections) || !voiceConnections[vc.id] ) return {success: false, message: "Not currently connected."};
  
      if ( voiceDispatchers[vc.id] ) voiceDispatchers[vc.id].end('dc');
      if ( vc.id in voiceIntervals ) clearInterval(voiceIntervals[vc.id]);
      voiceConnections[vc.id].disconnect();
      voiceConnections[vc.id] = false;
      return {success: true, message: "Disconnected."};
    }
    // description - clears the play queue
    clear(vc) {
      if (!vc) return {success: false, message: "You need to join a voice channel first (invalid voice channel)."};
      if (!(vc.id in voiceConnections) || !voiceConnections[vc.id] ) return {success: false, message: "Not currently connected."};
  
      voice[vc.id].autoplay = false;
      if ( voiceDispatchers[vc.id] ) voiceDispatchers[vc.id].end('stop');
      voice[vc.id].playlist = [];
      voice[vc.id].shuffle = [];
      this.db.updateDB();
      return {success: true, message: "Playlist cleared."};
    }
    // description - displays currently playing song
    current(vc) {
      if (!vc) return {success: false, message: "You need to join a voice channel first (invalid voice channel)."};
      if (!(vc.id in voiceConnections) || !voiceConnections[vc.id]) return {success: false, message: "Not currently connected."};
      if (!(vc.id in voiceDispatchers) || !voiceDispatchers[vc.id]) return {success: false, message: "Nothing is playing."};
  
      const np = voice[vc.id].playlist[voice[vc.id].currentSong];
      return {success: true, message: "", embed: {
        "embed": {
          "description": "[" + np.title + "](" + np.url + ")",
          "color": 0xad1457,
          "thumbnail": {
            "url": np.thumb
          },
          "author": {
            "name": "Now Playing",
            "icon_url": this.bot.user.avatarURL
          },
          "fields": [
            {
              "name": "Requested by",
              "value": np.owner,
              "inline": true
            },
            {
              "name": "Progress",
              "value": this.secToString((voiceDispatchers[vc.id].time/1000) + voice[vc.id].seek) + "/" + this.secToString(np.duration),
              "inline": true
            }
          ]
        }
      }};
    }
    // description - pauses playback
    pause(vc) {
      if (!vc) return {success: false, message: "You need to join a voice channel first (invalid voice channel)."};
      if (!(vc.id in voiceConnections) || !voiceConnections[vc.id] ) return {success: false, message: "Not currently connected."};
      if (!voiceDispatchers[vc.id]) return {success: false, message: "Nothing playing."};
      if (voiceDispatchers[vc.id].paused) return {success: false, message: "Already paused."};
  
      voiceDispatchers[vc.id].pause();
      return {success: true, message: "Paused."};
    }
    // descprition - resumes playback
    resume(vc) {
      if (!vc) return {success: false, message: "You need to join a voice channel first (invalid voice channel)."};
      if (!(vc.id in voiceConnections) || !voiceConnections[vc.id] ) return {success: false, message: "Not currently connected."};
      if (!voiceDispatchers[vc.id]) return {success: false, message: "Nothing playing."};
      if (!voiceDispatchers[vc.id].paused) return {success: false, message: "Already playing."};
  
      voiceDispatchers[vc.id].resume();
      return {success: false, message: "Resumed."};
    }
    // description - stops playback
    stop(vc) {
      if (!vc) return {success: false, message: "You need to join a voice channel first (invalid voice channel)."};
      if (!(vc.id in voiceConnections) || !voiceConnections[vc.id] ) return {success: false, message: "Not currently connected."};
      if (!voiceDispatchers[vc.id]) return {success: false, message: "Nothing playing."};
  
      voiceDispatchers[vc.id].end('stop');
      return {success: true, message: "Stopped."};
    }
    // description - moves one song forward
    next(vc) {
      if (!vc) return {success: false, message: "You need to join a voice channel first (invalid voice channel)."};
      if (!(vc.id in voiceConnections) || !voiceConnections[vc.id] ) return {success: false, message: "Not currently connected."};
      
      if (!voiceDispatchers[vc.id]) {
        if ( voice[vc.id].currentSong + 1 < voice[vc.id].playlist.length ) voice[vc.id].currentSong++;
      } else {
        voiceDispatchers[vc.id].end('next');
      };
      this.db.updateDB();
      return {success: true};
    }
    // description - moves one song backward
    previous(vc) {
      if (!vc) return {success: false, message: "You need to join a voice channel first (invalid voice channel)."};
      if (!(vc.id in voiceConnections) || !voiceConnections[vc.id] ) return {success: false, message: "Not currently connected."};
  
      if (!voiceDispatchers[vc.id]) {
        if ( voice[vc.id].currentSong > 0 ) voice[vc.id].currentSong--;
      } else {
        voiceDispatchers[vc.id].end('previous');
      };
      voice[vc.id].autoplay = false;
      this.db.updateDB();
      return {success: true};
    }
    // description - toggles loop
    loop(vc) {
      if (!vc) return {success: false, message: "You need to join a voice channel first (invalid voice channel)."};
      if (!(vc.id in voiceConnections) || !voiceConnections[vc.id] ) return {success: false, message: "Not currently connected."};
  
      voice[vc.id].loop = !voice[vc.id].loop;
      voice[vc.id].autoplay = false;
      this.db.updateDB();
      return {success: false, message: "Loop is now turned " + (voice[vc.id].loop ? 'ON' : 'OFF') + "."};
    }
    // description - toggles loop one
    loopOne(vc) {
      if (!vc) return {success: true, message: "You need to join a voice channel first (invalid voice channel)."};
      if (!(vc.id in voiceConnections) || !voiceConnections[vc.id] ) return {success: false, message: "Not currently connected."};
  
      voice[vc.id].loop1 = !voice[vc.id].loop1;
      this.db.updateDB();
      return {success: true, message: "Loop one is now turned " + (voice[vc.id].loop1 ? 'ON' : 'OFF') + "."};
    }
    // description - moves playing cursor to a specific time 
    //    argv - time in seconds
    seek(vc, argv) {
      if (!vc) return {success: false, message: "You need to join a voice channel first (invalid voice channel)."};
      if (!(vc.id in voiceConnections) || !voiceConnections[vc.id] ) return {success: false, message: "Not currently connected."};
      if (!voiceDispatchers[vc.id]) return {success: false, message: "Nothing playing."};
      
      if ( argv.length > 0 && argv[0] != '' && !isNaN(parseInt(argv[0])) && parseInt(argv[0]) >= 0 && parseInt(argv[0]) < voice[vc.id].playlist[voice[vc.id].currentSong].duration ) {
        let current = voice[vc.id].currentSong;
        voiceDispatchers[vc.id].end('stop');
        voice[vc.id].currentSong = current;
        this.playNext(vc.id, parseInt(argv[0]));
        return {success: false, message: "Playing starting at " + this.secToString(argv[0]) + "."};
      } else {
        return {success: false, message: "Invalid time."};
      }
    }
    // description - removes track from current queue
    //    argv - index of track to remove
    remove(vc, argv) {
      if (!vc) return {success: false, message: "You need to join a voice channel first (invalid voice channel)."};
      if (!(vc.id in voiceConnections) || !voiceConnections[vc.id] ) return {success: false, message: "Not currently connected."};
  
      voice[vc.id].autoplay = false;
      if ( argv.length > 0 && argv[0] != '' && !isNaN(parseInt(argv[0])) && argv[0] > 0 && argv[0] < voice[vc.id].playlist.length + 1) {
        if ( parseInt(argv[0]) == voice[vc.id].currentSong + 1 ) {
          voiceDispatchers[vc.id].end('next');
        }
        let song = JSON.parse(JSON.stringify(voice[vc.id].playlist[argv[0]-1]));
        voice[vc.id].playlist.splice(argv[0] - 1 ,1);
        if ( voice[vc.id].shuffle != [] ) {
          for ( let i = 0; i < voice[vc.id].shuffle.length; i++ ) {
            if ( song.url == voice[vc.id].shuffle[i].url ) {
              voice[vc.id].shuffle.splice(i ,1);
              break;
            }
          }
        }
        if ( argv[0] - 1 < voice[vc.id].currentSong ) voice[vc.id].currentSong--;
        this.db.updateDB();
        return {success: true, message: song.title + " removed from queue."};
      } else {
        return {success: false, message: "Invalid index."};
      }
    }
    // description - turns shuffle on 
    shuffle(vc) {
      if (!vc) return {success: false, message: "You need to join a voice channel first (invalid voice channel)."};
      if (!(vc.id in voiceConnections) || !voiceConnections[vc.id] ) return {success: false, message: "Not currently connected."};
  
      voice[vc.id].autoplay = false;
      // TODO : MIGHT BE BUGGY 
      if ( voice[vc.id].shuffle.length == 0 ) {
        voice[vc.id].shuffle = JSON.parse(JSON.stringify(voice[vc.id].playlist));
        if ( voiceDispatchers[vc.id] ) {
          let current = voice[vc.id].playlist[voice[vc.id].currentSong];
          voice[vc.id].playlist.splice(voice[vc.id].currentSong, 1);
          this.shuffleArray(voice[vc.id].playlist);
          voice[vc.id].playlist.unshift(current);
        } else {
          this.shuffleArray(voice[vc.id].playlist);
        }
        voice[vc.id].currentSong = 0;
      } else {
        let current = voice[vc.id].playlist[voice[vc.id].currentSong];
        voice[vc.id].playlist = JSON.parse(JSON.stringify(voice[vc.id].shuffle));
        voice[vc.id].shuffle = [];
        let newCurrent = 0;
        if ( voiceDispatchers[vc.id] ) {
          for ( let i = 0; i < voice[vc.id].playlist.length; i++ ) {
            if ( voice[vc.id].playlist[i].url == current.url ) {
              newCurrent = i;
              break;
            }
          }
        } 
        voice[vc.id].currentSong = newCurrent;
      }
      this.db.updateDB();
      return {success: true, message: "Shuffle is now turned " + (voice[vc.id].shuffle.length == 0 ? 'OFF' : 'ON') + "."};
    }
    // description - displays current queue
    queue(vc) {
      if (!vc) return {success: false, message: "You need to join a voice channel first (invalid voice channel)."};
      if (!(vc.id in voiceConnections) || !voiceConnections[vc.id] ) return {success: false, message: "Not currently connected."};
  
      let embed = {
        "embed": {
          "description": "```\n",
          "color": 0xad1457,
          "author": {
            "name": "Music Queue",
            "icon_url": this.bot.user.avatarURL
          }
        }
      };
      for ( let i = 0; i < voice[vc.id].playlist.length; i++ ) {
        let duration = this.secToString(voice[vc.id].playlist[i].duration);
        let strLen = duration.length + 9 + voice[vc.id].playlist[i].title.length - this.maxQueueStringLength;
        embed.embed.description += '' + (voice[vc.id].currentSong == i ? '-> ' : '   ') + (i+1).toString().padStart(2) + '. '; // 9 + duration
        if ( strLen > 0 ) {
          embed.embed.description += voice[vc.id].playlist[i].title.substring(0, voice[vc.id].playlist[i].title.length-strLen-3) + '...';
        } else {
          embed.embed.description += voice[vc.id].playlist[i].title.padEnd(Math.abs(strLen) + voice[vc.id].playlist[i].title.length);
        }
        embed.embed.description += ' (' + duration + ')\n';
      }
      if ( embed.embed.description == "```\n" ) {
        embed.embed.description = "Queue is empty.";
      } else {
        embed.embed.description += "```";
      }
      return {success: true, message: "", embed: embed};
    }
}

class Playlist {
  constructor(bot, db) {
    this.bot = bot;                             // reference to bot client
    this.db = db;                               // reference to db
  }

  // description - creates a list of saved playlists
  list(vc) {
    if (!vc) return {success: false, message: "You need to join a voice channel first (invalid voice channel)."};

    let embed = {
      "embed": {
        "description": "```\n",
        "color": 0xad1457,
        "author": {
          "name": "Saved Playlists",
          "icon_url": this.bot.user.avatarURL
        }
      }
    };
    for ( let i = 0; i < voice[vc.id].saved.length; i++ ) {
      embed.embed.description += (i+1).toString().padStart(3) + '. ' + voice[vc.id].saved[i].name + ' (' + voice[vc.id].saved[i].playlist.length + ' tracks, ' + Math.floor(voice[vc.id].saved[i].duration/60) + ' min) - ' + voice[vc.id].saved[i].owner + '\n';
    }
    if ( embed.embed.description == "```\n" ) {
      embed.embed.description = "There are no saved playlists.";
    } else {
      embed.embed.description += "```";
    }
    return {success: true, message: "", embed: embed};
  }
  // description - saves a new playlist
  save (vc, name, owner) {
    if (!vc) return {success: false, message: "You need to join a voice channel first (invalid voice channel)."};

    if ( name == '' || !isNaN(parseInt(name)) ) return {success: false, message: "Invalid or numeric name."};
    for ( let i = 0; i < voice[vc.id].saved.length; i++ ) {
      if ( name == voice[vc.id].saved[i].name ) return {success: false, message: "Name already in use."};
    }
    if ( voice[vc.id].playlist.length == 0 ) return {success: false, message: "Playlist is empty."};
    let duration = 0;
    for ( let i = 0; i < voice[vc.id].playlist.length; i++ ) {
      duration += parseInt(voice[vc.id].playlist[i].duration);
    }
    voice[vc.id].saved.push({'name': name, 'playlist': JSON.parse(JSON.stringify(voice[vc.id].playlist)), 'owner': owner, 'duration': duration});
    this.db.updateDB();
    return {success: true, message: "Playlist " + name + " saved."};
  }

  // description - removes saved playlist
  remove(vc, name, owner) {
    if (!vc) return {success: false, message: "You need to join a voice channel first (invalid voice channel)."};

    if ( name == '' ) return {success: false, message: "Invalid name."};
    if ( isNaN(parseInt(name)) ) {
      for ( let i = 0; i < voice[vc.id].saved.length; i++ ) {
        if ( name == voice[vc.id].saved[i].name ) { 
          if ( voice[vc.id].saved[i].owner != owner ) return {success: false, message: "Premission error."};
          voice[vc.id].saved.splice(i, 1);
          break;
        }
      }
    } else {
      if ( parseInt(name) < 1 || parseInt(name) > voice[vc.id].saved.length ) return {success: false, message: "Invalid index."};
      if ( voice[vc.id].saved[parseInt(name)].owner != owner ) return {success: false, message: "Premission error."};
      voice[vc.id].saved.splice(parseInt(name) - 1, 1);
    }
    return {success: true, message: "playlist " + name + " removed."};
    this.db.updateDB();
  }

  // description - loads saved playlist
  load(vc, name) {
    if (!vc) return {success: false, message: "You need to join a voice channel first (invalid voice channel)."};

    if ( name == '' ) return {success: false, message: "Invalid name."};
    if ( !isNaN(parseInt(name)) && parseInt(name) > 0 && parseInt(name) <= voice[vc.id].saved.length ) {
        if ( voiceDispatchers[vc.id] ) voiceDispatchers[vc.id].end('stop');
        voice[vc.id].playlist = JSON.parse(JSON.stringify(voice[vc.id].saved[parseInt(name) - 1].playlist));
        voice[vc.id].currentSong = 0;
        this.db.updateDB();
        return {success: true, message: "Playlist " + voice[vc.id].saved[parseInt(name) - 1].name + " loaded."};
    }
    for ( let i = 0; i < voice[vc.id].saved.length; i++ ) {
      if ( voice[vc.id].saved[i].name == name ) {
        if ( voiceDispatchers[vc.id] ) voiceDispatchers[vc.id].end('stop');
        voice[vc.id].playlist = JSON.parse(JSON.stringify(voice[vc.id].saved[i].playlist));
        voice[vc.id].currentSong = 0;
        this.db.updateDB();
        return {success: true, message: "Playlist " + name + " loaded."};
      }
    }
    return {success: false, message: "Playlist " + name + " doesn't exist."};
  }
}

class DB {
  constructor(mongoConnection, voice) {
    this.mongoConnection = mongoConnection;   // mongo connection string  
  }
  // description - loads voice object from mongo
  loadFromDB() {
    return new Promise(async (resolve, reject) => {
      try {
        let client = await MongoClient.connect(this.mongoConnection);
        const db = client.db(this.mongoConnection.split('/')[this.mongoConnection.split('/').length - 1]);
        voice = await db.collection('voice').findOne();
        delete voice['_id'];
        return resolve(true);
      } catch (e) {
        console.dir(e);
        return resolve(false);
      }
    })
  } 
  // description - saves voice object to mongo
  async updateDB() {
    try {
      let client = await MongoClient.connect(this.mongoConnection);
      const db = client.db(this.mongoConnection.split('/')[this.mongoConnection.split('/').length - 1]);
      await db.collection('voice').replaceOne({}, voice);
    } catch (e) {
      console.dir(e);
    }
  }
}

module.exports = { Musicbot: Musicbot }
