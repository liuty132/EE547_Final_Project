const uploadsRes = await fetch("/user-tracks/0", {
    headers: { Authorization: `Bearer ${token}` }
});

const uploads = await uploadsRes.json();
const uploadContainer = document.getElementById("uploads-list");
uploadContainer.innerHTML = uploads.length ? "" : "<p class='text-muted'>No uploads yet.</p>";

uploads.forEach(track => {
    const item = document.createElement("div");
    item.className = "card p-4 rounded-lg shadow flex items-center justify-between";
    item.innerHTML = `
    <div>
        <p class="font-semibold text-lg">${track.track_name || "Untitled Track"}</p>
        <p class="text-sm text-muted">Uploaded: ${new Date(track.uploaded_at).toLocaleDateString()}</p>
    </div>
    <audio controls src="${track.audio_url}" class="w-64"></audio>
    `;
    uploadContainer.appendChild(item);
});

async function loadUserPlaylists() {
    const token = localStorage.getItem("authToken");
    const res = await fetch("/user-playlists", {
        headers: { Authorization: `Bearer ${token}` }
    });

    const playlists = await res.json();
    const container = document.getElementById("playlists-list");
    container.innerHTML = playlists.length ? "" : "<p class='text-muted'>No playlists yet.</p>";

    playlists.forEach(p => {
        const div = document.createElement("div");
        div.className = "card p-4 rounded-lg shadow flex justify-between items-center";
        div.innerHTML = `
        <div>
            <p class="font-semibold text-lg">${p.playlist_name}</p>
            <p class="text-sm text-muted">Created: ${new Date(p.created_at || Date.now()).toLocaleDateString()}</p>
        </div>
        `;
        container.appendChild(div);
    });
}

window.onload = () => {
    loadUserUploads();
    loadUserPlaylists();
};