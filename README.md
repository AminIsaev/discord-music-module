# Discord music bot module

Module containing basic functions for a discord music bot written in Node.js using Discord.js library for discord connection. Requires mongoDB connection for storing data and YouTube API key to use music search.

To initialize : 
`var musicbot = new Musicbot(mongo connection string, discord.js client, youtube api key);`

Available functions (vc argument - discord.js voice channel object) : 
- **join(vc)** - Joins a voice channel.
- **leave(vc)** - Leaves a voice channel.
- **play(vc, argv, owner)** - Plays or queues a song.
  - argv - Youtube url or search query.
  - owner - Discord user who requested a song.
- **autoplay(vc, argv, owner)** - Plays a song with autoplay on (picks next songs from youtube relevant videos).
  - argv - Youtube url or search query.
  - owner - Discord user who requested a song.
- **current(vc)** - Displays information about current song.
- **queue(vc)** - Displays current playlist.
- **pause(vc)** - Pauses playback.
- **resume(vc)** - Resumes playback.
- **stop(vc)** - Stops playback.
- **clear(vc)** - Clears playlist.
- **next(vc)** - Skips to next song.
- **previous(vc)** - Moves one song backwards.
- **seek(vc, argv)** - Moves to a specific time inside a song.
  - argv - Time in seconds.
- **remove(vc, argv)** - Removes selected song from playlist.
  - argv - Index of song to remove.
- **loop(vc)** - Toggles loop function.
- **loopOne(vc)** - Toggles loop one function.
- **shuffle(vc)** - Toggles shuffle function.
- **playlist.save(vc, argv, owner)** - Saves current playlist.
  - argv - Name of the new playlist.
  - owner - Discord user who is saving the playlist.
- **playlist.load(vc, argv)** - Loads playlist.
  - argv - Name or index of playlist to load.
- **playlist.list(vc)** - Lists saved playlists.
- **playlist.remove(vc, argv, owner)** - Removes saved playlist.
  - argv - Name or index of playlist to remove.
  - owner - Discord user who is requesting playlist deletion.
