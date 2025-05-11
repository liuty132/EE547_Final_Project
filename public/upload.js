document.addEventListener('DOMContentLoaded', function() {
    const fileInput = document.getElementById('audioFile');
    const fileName = document.getElementById('fileName');
    const submitBtn = document.getElementById('submitBtn');
    const progressContainer = document.getElementById('progressContainer');
    const progressBar = document.getElementById('progressBar');
    const statusMessage = document.getElementById('statusMessage');
    const conversionResults = document.getElementById('conversionResults');
    const trackInfo = document.getElementById('trackInfo');
    const downloadBtn = document.getElementById('downloadBtn');
    
    // File selection
    fileInput.addEventListener('change', function() {
        if (this.files.length > 0) {
            fileName.textContent = this.files[0].name;
            submitBtn.style.display = 'inline-block';
        } else {
            fileName.textContent = 'No file selected';
            submitBtn.style.display = 'none';
        }
    });
    // Upload button
    submitBtn.addEventListener('click', async function() {
        const file = fileInput.files[0];
        if (!file) return;
        const token = localStorage.getItem('accessToken');
        // if (!token) {
        //     alert('Please log in to upload files');
        //     return;
        // }
        // Progress bar
        progressContainer.style.display = 'block';
        submitBtn.disabled = true;
        const formData = new FormData();
        formData.append('audio', file);
        try {
            const response = await fetch('/upload-audio', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`
                },
                body: formData
            });
            if (response.ok) {
                progressBar.style.width = '100%';
                statusMessage.textContent = 'Upload successful!';
                // Extract track information
                const data = await response.json();
                console.log("Response data:", data);
                let trackId, trackName, coverImageUrl;
                if (data.metadata) {
                    const metadata = typeof data.metadata === 'string' 
                        ? JSON.parse(data.metadata) 
                        : data.metadata;
                    trackId = metadata.fileId;
                    trackName = file.name.replace(/\.[^/.]+$/, ""); 
                    coverImageUrl = metadata.coverImageUrl;
                }
                trackInfo.innerHTML = '';
                // Add track name
                const trackNameElement = document.createElement('p');
                trackNameElement.className = 'text-lg font-semibold mb-3';
                trackNameElement.textContent = `Track: ${trackName}`;
                trackInfo.appendChild(trackNameElement);
                // Add cover art if available
                if (coverImageUrl) {
                    const coverArt = document.createElement('img');
                    coverArt.src = coverImageUrl;
                    coverArt.alt = 'Album Cover';
                    coverArt.className = 'mx-auto w-32 h-32 object-cover rounded mb-4';
                    trackInfo.appendChild(coverArt);
                }
                downloadBtn.onclick = function() {
                    fetch(`/get-audio/${trackId}`, {
                        method: 'GET',
                        headers: {
                            'Authorization': `Bearer ${token}`
                        }
                    })
                    .then(response => response.blob())
                    .then(blob => {
                        // Create a download link for the blob
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
                };
                // Show conversion results
                conversionResults.classList.remove('hidden');
                // Hide progress after a short delay
                setTimeout(() => {
                    progressContainer.style.display = 'none';
                    submitBtn.disabled = false;
                    fileInput.value = '';
                    fileName.textContent = 'No file selected';
                    submitBtn.style.display = 'none';
                }, 1000);
            } else {
                const errorData = await response.json();
                throw new Error(errorData.error || 'Upload failed');
            }
        } catch (error) {
            progressBar.style.width = '0%';
            statusMessage.textContent = `Error: ${error.message}`;
            submitBtn.disabled = false;
        }
    });
});