// Check for existing session on page load
document.addEventListener('DOMContentLoaded', async function() {
    // Check localStorage for existing username first
    const storedUsername = localStorage.getItem('username');
    if (storedUsername) {
        document.getElementById('logout-btn').style.display = 'block';
        document.getElementById('username-display').style.display = 'inline';
        document.getElementById('username-display').textContent = `Welcome, ${storedUsername}`;
        document.querySelector('button[onclick="showForm(\'login-form\')"]').style.display = 'none';
        document.querySelector('button[onclick="showForm(\'signup-form\')"]').style.display = 'none';
        document.getElementById('dashboard-btn').classList.remove('pointer-events-none', 'opacity-50');
        // return;
    }

    try {
        // Try to refresh the token
        const response = await fetch('/refresh-token', {
            method: 'POST',
            credentials: 'include'
        });
        if (response.ok) {
            const data = await response.json();
            // Store the new access token
            localStorage.setItem('accessToken', data.accessToken);
            // Get user info using the token
            const userResponse = await fetch('/user-info', {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${data.accessToken}`
                },
                credentials: 'include'
            });
            if (userResponse.ok) {
                const userData = await userResponse.json();
                // Update UI to show logged in state
                document.getElementById('logout-btn').style.display = 'block';
                document.getElementById('username-display').style.display = 'inline';
                document.getElementById('username-display').textContent = `Welcome, ${userData.username}`;
                document.querySelector('button[onclick="showForm(\'login-form\')"]').style.display = 'none';
                document.querySelector('button[onclick="showForm(\'signup-form\')"]').style.display = 'none';
                document.getElementById('dashboard-btn').style.display = 'inline';
                document.getElementById('dashboard-btn').classList.remove('pointer-events-none', 'opacity-50');
                localStorage.setItem('username', userData.username);
            }
        } else {
            // If not logged in, show signup and login buttons
            document.querySelector('button[onclick="showForm(\'login-form\')"]').style.display = 'block';
            document.querySelector('button[onclick="showForm(\'signup-form\')"]').style.display = 'block';
            document.getElementById('username-display').style.display = 'none';
            document.getElementById('dashboard-btn').classList.add('pointer-events-none', 'opacity-50');
        }
    } catch (error) {
        console.error('Session restoration error:', error);
        // If refresh fails, show signup and login buttons
        document.querySelector('button[onclick="showForm(\'login-form\')"]').style.display = 'block';
        document.querySelector('button[onclick="showForm(\'signup-form\')"]').style.display = 'block';
        document.getElementById('username-display').style.display = 'none';
    }
});


// Show/hide forms
function showForm(formId) {
    document.getElementById(formId).classList.remove('hidden');
}

function hideForm(formId) {
    document.getElementById(formId).classList.add('hidden');
}


// Auth functions
async function signup() {
    const username = document.getElementById('signup-username').value;
    const email = document.getElementById('signup-email').value;
    const password = document.getElementById('signup-password').value;
    
    try {
        const response = await fetch('/signup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, email, password })
        });
        const data = await response.json();
        if (response.ok) {
            document.getElementById('signup-message').textContent = 'Signup successful! Check your email for verification code.';
            document.getElementById('verification-section').style.display = 'block';
            // Store username for verification
            document.getElementById('verification-section').dataset.username = username;
        } else {
            document.getElementById('signup-message').textContent = 'Error: ' + (data.error || 'Signup failed');
        }
    } catch (error) {
        document.getElementById('signup-message').textContent = 'Error: ' + error.message;
    }
}

async function verifyEmail() {
    const username = document.getElementById('verification-section').dataset.username;
    const code = document.getElementById('verification-code').value;
    try {
        const response = await fetch('/confirm', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, code })
        });
        const data = await response.json();
        if (response.ok) {
            document.getElementById('verification-message').textContent = 'Email verified successfully!';
            document.getElementById('verification-section').style.display = 'none';
            hideForm('signup-form');
        } else {
            document.getElementById('verification-message').textContent = 'Error: ' + (data.error || 'Verification failed');
        }
    } catch (error) {
        document.getElementById('verification-message').textContent = 'Error: ' + error.message;
    }
}

async function login() {
    const username = document.getElementById('login-username').value;
    const password = document.getElementById('login-password').value;
    try {
        const response = await fetch('/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password }),
            credentials: 'include'
        });
        const data = await response.json();
        if (response.ok) {
            // Store the access token in localStorage
            localStorage.setItem('accessToken', data.accessToken);
            
            document.getElementById('login-message').textContent = 'Login successful!';
            document.getElementById('logout-btn').style.display = 'block';
            document.getElementById('username-display').style.display = 'inline';
            document.getElementById('username-display').textContent = `Welcome, ${username}`;
            document.querySelector('button[onclick="showForm(\'login-form\')"]').style.display = 'none';
            document.querySelector('button[onclick="showForm(\'signup-form\')"]').style.display = 'none';
            document.getElementById('dashboard-btn').style.display = 'inline';
            hideForm('login-form');
            document.getElementById('dashboard-btn').classList.remove('pointer-events-none', 'opacity-50');
        } else {
            document.getElementById('login-message').textContent = 'Error: ' + (data.error || 'Login failed');
        }
    } catch (error) {
        document.getElementById('login-message').textContent = 'Error: ' + error.message;
    }
}

async function logout() {
    try {
        // Get the access token from local1
        const accessToken = localStorage.getItem('accessToken');
        const response = await fetch('/logout', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`
            },
            credentials: 'include'
        });
    } catch (error) {
        console.error('Logout error:', error);
    }
    // Clear user data from localStorage
    localStorage.removeItem('accessToken');
    localStorage.removeItem('username');
    // Hide logout button and username display
    document.getElementById('logout-btn').style.display = 'none';
    document.getElementById('username-display').style.display = 'none';
    // Show both signup and login buttons
    const signupBtn = document.querySelector('button[onclick="showForm(\'signup-form\')"]');
    const loginBtn = document.querySelector('button[onclick="showForm(\'login-form\')"]');
    signupBtn.style.display = 'block';
    loginBtn.style.display = 'block';
    // Clear any form messages
    document.getElementById('login-message').textContent = '';
    document.getElementById('signup-message').textContent = '';
    if (window.location.pathname.includes('/dashboard')) {
        window.location.href = '/';
    }
    document.getElementById('dashboard-btn').classList.add('pointer-events-none', 'opacity-50');
}