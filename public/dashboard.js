let currentPage = 0;
let currentView = 'library';
let currentPlaylistId = null;
let selectedTracks = new Set();
let audioPlayer = new Audio();


// init
document.addEventListener('DOMContentLoaded', async () => {
    const token = localStorage.getItem('accessToken');
    if (!token) {
        window.location.href = '/';
        return;
    }
    setupEventListeners();
    setupAudioPlayerEvents();
    await loadUserPlaylists();
    await loadTracks(0);
});


// init setup helper function
function setupEventListeners() {
    // sidebar
    document.getElementById('all-tracks-btn').addEventListener('click', () => {
        setActiveView('library');
        loadTracks(0);
    });
    // play 
    document.getElementById('shuffle-btn').addEventListener('click', () => {
        if (currentView === 'library') {
            shufflePlay();
        } else if (currentView === 'playlist' && currentPlaylistId) {
            shufflePlayPlaylist(currentPlaylistId);
        }
    });
    // stop 
    document.getElementById('stop-btn').addEventListener('click', stopPlayback);
    // pagination
    document.getElementById('prev-page-btn').addEventListener('click', () => {
        if (currentPage > 0) {
            if (currentView === 'library') {
                loadTracks(currentPage - 1);
            } else {
                loadPlaylistTracks(currentPlaylistId, currentPage - 1);
            }
        }
    });
    document.getElementById('next-page-btn').addEventListener('click', () => {
        if (currentView === 'library') {
            loadTracks(currentPage + 1);
        } else {
            loadPlaylistTracks(currentPlaylistId, currentPage + 1);
        }
    });
    // checkbox
    document.getElementById('select-all-checkbox').addEventListener('change', (e) => {
        const checkboxes = document.querySelectorAll('.track-checkbox');
        checkboxes.forEach(checkbox => {
            checkbox.checked = e.target.checked;
            const trackId = parseInt(checkbox.dataset.trackId);
            if (e.target.checked) {
                selectedTracks.add(trackId);
            } else {
                selectedTracks.delete(trackId);
            }
        });
        updateActionButtons();
    });
    // new playlist
    document.getElementById('new-playlist-btn').addEventListener('click', () => {
        document.getElementById('new-playlist-form').classList.remove('hidden');
    });
    document.getElementById('create-playlist').addEventListener('click', createNewPlaylist);
    document.getElementById('cancel-new-playlist').addEventListener('click', () => {
        document.getElementById('new-playlist-form').classList.add('hidden');
        document.getElementById('playlist-name').value = '';
    });
    // add tracks to playlist
    document.getElementById('add-to-playlist-btn').addEventListener('click', showAddToPlaylistForm);
    document.getElementById('cancel-add-to-playlist').addEventListener('click', () => {
        document.getElementById('add-to-playlist-form').classList.add('hidden');
    });
    document.getElementById('confirm-add-to-playlist').addEventListener('click', addSelectedTracksToPlaylist);
    // delete tracks from 
    document.getElementById('delete-tracks-btn').addEventListener('click', deleteSelectedTracks);
}


// load all tracks in library
async function loadTracks(page) {
    currentPage = page;
    currentView = 'library';
    currentPlaylistId = null;
    document.getElementById('content-title').textContent = 'Your Tracks';
    document.getElementById('tracks-container').innerHTML = '<tr><td colspan="8" class="text-center py-8 text-muted">Loading your tracks...</td></tr>';
    try {
        const token = localStorage.getItem('accessToken');
        const response = await fetch(`/user-tracks/${page * 25}`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        const tracks = await response.json();
        renderTracks(tracks);
        // pagination buttons
        document.getElementById('prev-page-btn').disabled = page === 0;
        document.getElementById('next-page-btn').disabled = tracks.length < 25;
        document.getElementById('tracks-count').textContent = `Showing ${tracks.length} tracks`;
        // reset selected tracks
        selectedTracks.clear();
        document.getElementById('select-all-checkbox').checked = false;
        updateActionButtons();
        setActiveView('library');
    } catch (error) {
        console.error('Error loading tracks:', error);
        document.getElementById('tracks-container').innerHTML = '<tr><td colspan="8" class="text-center py-8 text-red-500">Failed to load tracks. Please try again.</td></tr>';
    }
}


// load playlist
async function loadUserPlaylists() {
    try {
        const token = localStorage.getItem('accessToken');
        const response = await fetch('/user-playlists', {
            headers: { Authorization: `Bearer ${token}` }
        });
        if (!response.ok) {
            throw new Error('Failed to load playlists');
        }
        const playlists = await response.json();
        const container = document.getElementById('playlists-sidebar');
        if (playlists.length === 0) {
            container.innerHTML = '<p class="text-muted text-sm">No playlists yet</p>';
            return;
        }
        container.innerHTML = '';
        playlists.forEach(playlist => {
            const item = document.createElement('div');
            item.className = 'sidebar-item flex items-center';
            item.dataset.playlistId = playlist.playlist_id;
            item.innerHTML = `
                <i class="fas fa-list-ul mr-2"></i>
                <span class="truncate">${playlist.playlist_name}</span>
            `;
            item.addEventListener('click', () => {
                loadPlaylistTracks(playlist.playlist_id, 0);
            });
            container.appendChild(item);
        });
        updatePlaylistOptions(playlists);
    } catch (error) {
        console.error('Error loading playlists:', error);
        document.getElementById('playlists-sidebar').innerHTML = '<p class="text-red-500 text-sm">Failed to load playlists</p>';
    }
}


// load tracks from playlist
async function loadPlaylistTracks(playlistId, page) {
    currentPage = page;
    currentView = 'playlist';
    currentPlaylistId = playlistId;
    const playlistName = document.querySelector(`.sidebar-item[data-playlist-id="${playlistId}"] span`).textContent;
    document.getElementById('content-title').textContent = playlistName;
    document.getElementById('tracks-container').innerHTML = '<tr><td colspan="8" class="text-center py-8 text-muted">Loading playlist tracks...</td></tr>';
    try {
        const token = localStorage.getItem('accessToken');
        const response = await fetch(`/playlist/${playlistId}/${page * 25}`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        setActiveView('playlist', playlistId);
        const data = await response.json();
        const tracks = data.tracks || [];
        renderTracks(tracks);
        // pagination buttons
        document.getElementById('prev-page-btn').disabled = page === 0;
        document.getElementById('next-page-btn').disabled = tracks.length < 25;
        document.getElementById('tracks-count').textContent = `Showing ${tracks.length} tracks`;
        // reset selected tracks
        selectedTracks.clear();
        document.getElementById('select-all-checkbox').checked = false;
        updateActionButtons();
    } catch (error) {
        console.error('Error loading playlist tracks:', error);
        document.getElementById('tracks-container').innerHTML = '<tr><td colspan="8" class="text-center py-8 text-red-500">Failed to load playlist tracks. Please try again.</td></tr>';
    }
}


// render table for tracks
function renderTracks(tracks) {
    const container = document.getElementById('tracks-container');
    if (tracks.length === 0) {
        container.innerHTML = '<tr><td colspan="7" class="text-center py-8 text-muted">No tracks found</td></tr>';
        return;
    }
    container.innerHTML = '';
    tracks.forEach(track => {
        const row = document.createElement('tr');
        // format duration
        const minutes = Math.floor(track.duration_ms / 60000);
        const seconds = Math.floor((track.duration_ms % 60000) / 1000);
        const formattedDuration = `${minutes}:${seconds.toString().padStart(2, '0')}`;
        // cover art 
        const coverArt = track.track_image_url || '/images/placeholder.png';
        row.innerHTML = `
            <td>
                <input type="checkbox" class="track-checkbox" data-track-id="${track.track_id}">
            </td>
            <td>
                <img src="${coverArt}" alt="Cover" class="w-10 h-10 rounded">
            </td>
            <td>${track.track_name || 'Unknown'}</td>
            <td>${track.artist_name || 'Unknown Artist'}</td>
            <td>${track.track_album || 'Unknown Album'}</td>
            <td>${formattedDuration}</td>
            <td>
                <button class="download-button text-blue-400 hover:text-blue-300" data-track-id="${track.track_id}" data-track-name="${track.track_name || 'track'}">
                    <i class="fas fa-download"></i>
                </button>
            </td>`;
        // Add event listeners
        const checkbox = row.querySelector('.track-checkbox');
        checkbox.addEventListener('change', (e) => {
            const trackId = parseInt(e.target.dataset.trackId);
            if (e.target.checked) {
                selectedTracks.add(trackId);
            } else {
                selectedTracks.delete(trackId);
            }
            updateActionButtons();
        });
        const downloadButton = row.querySelector('.download-button');
        downloadButton.addEventListener('click', () => {
            const trackId = parseInt(downloadButton.dataset.trackId);
            const trackName = downloadButton.dataset.trackName;
            downloadTrack(trackId, trackName);
        });
        container.appendChild(row);
    });
}


// download
function downloadTrack(trackId, trackName) {
    const token = localStorage.getItem('accessToken');
    fetch(`/get-audio/${trackId}`, {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${token}`
        }
    })
    .then(response => response.blob())
    .then(blob => {
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        a.download = `${trackName}.mp3`;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
    })
    .catch(error => {
        console.error('Download error:', error);
        alert('Failed to download the file. Please try again.');
    });
}


// show or hide add & delete buttons based on track selection
function updateActionButtons() {
    const actionButtons = document.getElementById('action-buttons');
    const addToPlaylistBtn = document.getElementById('add-to-playlist-btn');
    const deleteTracksBtn = document.getElementById('delete-tracks-btn');
    if (selectedTracks.size > 0) {
        actionButtons.classList.remove('hidden');
        addToPlaylistBtn.classList.remove('hidden');
        deleteTracksBtn.classList.remove('hidden');
    } else {
        actionButtons.classList.add('hidden');
        addToPlaylistBtn.classList.add('hidden');
        deleteTracksBtn.classList.add('hidden');
    }
}


// set active view in sidebar
function setActiveView(view, playlistId = null) {
    // Remove active class from all sidebar items
    document.querySelectorAll('.sidebar-item').forEach(item => {
        item.classList.remove('active');
    });
    if (view === 'library') {
        document.getElementById('all-tracks-btn').classList.add('active');
    } else if (view === 'playlist' && playlistId) {
        document.querySelector(`.sidebar-item[data-playlist-id="${playlistId}"]`).classList.add('active');
    }
}


// new playlist
async function createNewPlaylist() {
    const playlistName = document.getElementById('playlist-name').value.trim();
    if (!playlistName) {
        alert('Please enter a playlist name');
        return;
    }
    try {
        const token = localStorage.getItem('accessToken');
        const response = await fetch('/new-playlist', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ playlistName })
        });
        if (!response.ok) {
            const data = await response.json();
            throw new Error(data.error || 'Failed to create playlist');
        }
        // Hide Form
        document.getElementById('new-playlist-form').classList.add('hidden');
        document.getElementById('playlist-name').value = '';
        // Reload playlists
        await loadUserPlaylists();
    } catch (error) {
        console.error('Error creating playlist:', error);
        alert(error.message);
    }
}


// form for adding selected tracks to playlist
function showAddToPlaylistForm() {
    if (selectedTracks.size === 0) {
        alert('Please select at least one track');
        return;
    }
    document.getElementById('add-to-playlist-form').classList.remove('hidden');
}


// form for add selected tracks to playlist
function updatePlaylistOptions(playlists) {
    const container = document.getElementById('playlist-options');
    if (playlists.length === 0) {
        container.innerHTML = '<p class="text-muted">No playlists available. Create a playlist first.</p>';
        document.getElementById('confirm-add-to-playlist').disabled = true;
        return;
    }
    container.innerHTML = '';
    playlists.forEach(playlist => {
        const option = document.createElement('div');
        option.className = 'flex items-center';
        option.innerHTML = `
            <input type="radio" name="playlist-option" id="playlist-${playlist.playlist_id}" value="${playlist.playlist_id}" class="mr-2">
            <label for="playlist-${playlist.playlist_id}">${playlist.playlist_name}</label>
        `;
        container.appendChild(option);
    });
    document.getElementById('confirm-add-to-playlist').disabled = false;
}


// add tracks to playlist
async function addSelectedTracksToPlaylist() {
    const selectedPlaylist = document.querySelector('input[name="playlist-option"]:checked');
    if (!selectedPlaylist) {
        alert('Please select a playlist');
        return;
    }
    const playlistId = selectedPlaylist.value;
    const trackIds = Array.from(selectedTracks);
    try {
        const token = localStorage.getItem('accessToken');
        const response = await fetch('/add-to-playlist', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ trackIds, playlistId })
        });
        if (!response.ok) {
            const data = await response.json();
            throw new Error(data.error || 'Failed to add tracks to playlist');
        }
        document.getElementById('add-to-playlist-form').classList.add('hidden');
        // reload
        if (currentView === 'playlist' && currentPlaylistId === parseInt(playlistId)) {
            loadPlaylistTracks(currentPlaylistId, currentPage);
        }
    } catch (error) {
        console.error('Error adding tracks to playlist:', error);
        alert(error.message);
    }
}


// delete tracks
async function deleteSelectedTracks() {
    const trackIds = Array.from(selectedTracks);
    try {
        const token = localStorage.getItem('accessToken');
        let url, requestBody;
        if (currentView === 'library') {
            url = '/tracks';
            requestBody = { trackIds };
        } else if (currentView === 'playlist') {
            url = `/playlist/${currentPlaylistId}/tracks`;
            requestBody = { trackIds };
        }
        const response = await fetch(url, {
            method: 'DELETE',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify(requestBody)
        });
        if (!response.ok) {
            const data = await response.json();
            throw new Error(data.error || 'Failed to delete tracks');
        }
        // reload current view
        if (currentView === 'library') {
            loadTracks(currentPage);
        } else {
            loadPlaylistTracks(currentPlaylistId, currentPage);
        }
    } catch (error) {
        console.error('Error deleting tracks:', error);
        alert(error.message);
    }
}


// ---------------------- Playback Functions ----------------------
// auto play next track
function setupAudioPlayerEvents() {
    audioPlayer.addEventListener('ended', () => {
        if (currentView === 'library') {
            shufflePlay();
        } else if (currentView === 'playlist' && currentPlaylistId) {
            shufflePlayPlaylist(currentPlaylistId);
        }
    });
    
    // Add track name display when a new track starts
    audioPlayer.addEventListener('play', () => {
        const trackName = audioPlayer.getAttribute('data-track-name');
        if (trackName) {
            console.log(`Now playing: ${trackName}`);
            // Optional: Display the track name in the UI
            document.getElementById('now-playing').textContent = `Now playing: ${trackName}`;
        }
    });
}


// all tracks shuffle
async function shufflePlay() {
    try {
        const token = localStorage.getItem('accessToken');
        const response = await fetch('/stream-tracks', {
            headers: { Authorization: `Bearer ${token}` }
        });
        if (!response.ok) {
            throw new Error('Failed to stream tracks');
        }
        const trackName = response.headers.get('X-Track-Name');
        const audioBlob = await response.blob();
        const audioUrl = URL.createObjectURL(audioBlob);
        audioPlayer.src = audioUrl;
        audioPlayer.setAttribute('data-track-name', trackName || 'Unknown Track');
        document.getElementById('now-playing').textContent = `Now playing: ${trackName || 'Unknown Track'}`;
        audioPlayer.play().catch(error => {
            console.error('Error playing track:', error);
        });
    } catch (error) {
        console.error('Error streaming tracks:', error);
        alert('Failed to stream tracks. Please try again.');
    }
}


// playlist shuffle
async function shufflePlayPlaylist(playlistId) {
    try {
        const token = localStorage.getItem('accessToken');
        const response = await fetch(`/stream-playlist/${playlistId}`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        if (!response.ok) {
            throw new Error('Failed to stream playlist');
        }
        const trackName = response.headers.get('X-Track-Name');
        const audioBlob = await response.blob();
        const audioUrl = URL.createObjectURL(audioBlob);
        audioPlayer.src = audioUrl;
        audioPlayer.setAttribute('data-track-name', trackName || 'Unknown Track');
        document.getElementById('now-playing').textContent = `Now playing: ${trackName || 'Unknown Track'}`;
        audioPlayer.play().catch(error => {
            console.error('Error playing track:', error);
        });
    } catch (error) {
        console.error('Error streaming playlist:', error);
        alert('Failed to stream playlist. Please try again.');
    }
}


// stop
function stopPlayback() {
    audioPlayer.pause();
    audioPlayer.currentTime = 0;
    document.getElementById('now-playing').textContent = 'Not Playing';
}