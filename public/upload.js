document.addEventListener('DOMContentLoaded', function() {
    const fileInput = document.getElementById('audioFile');
    const fileName = document.getElementById('fileName');
    const submitBtn = document.getElementById('submitBtn');
    const progressContainer = document.getElementById('progressContainer');
    const progressBar = document.getElementById('progressBar');
    const statusMessage = document.getElementById('statusMessage');
    const loginBtn = document.getElementById('loginBtn');
    const signupBtn = document.getElementById('signupBtn');
    const logoutBtn = document.getElementById('logoutBtn');
    
    // Check if user is logged in
    const token = localStorage.getItem('accessToken');
    if (token) {
        loginBtn.style.display = 'none';
        signupBtn.style.display = 'none';
        logoutBtn.style.display = 'inline-block';
    }
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
        // Check if user is logged in
        const token = localStorage.getItem('accessToken');
        if (!token) {
            alert('Please log in to upload files');
            return;
        }
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
                setTimeout(() => {
                    progressContainer.style.display = 'none';
                    fileInput.value = '';
                    fileName.textContent = 'No file selected';
                    submitBtn.style.display = 'none';
                    submitBtn.disabled = false;
                }, 100);
            } else {
                const errorData = await response.json();
                throw new Error(errorData.error || 'Upload timed out');
            }
        } catch (error) {
            progressBar.style.width = '0%';
            statusMessage.textContent = `Error: ${error.message}`;
            submitBtn.disabled = false;
        }
    });
});