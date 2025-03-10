document.addEventListener('DOMContentLoaded', () => {
    // DOM Elements
    const tokenInput = document.getElementById('token');
    const channelIdInput = document.getElementById('channelId');
    const loginBtn = document.getElementById('loginBtn');
    const startBtn = document.getElementById('startBtn');
    const stopBtn = document.getElementById('stopBtn');
    const clearLogBtn = document.getElementById('clearLogBtn');
    const toggleTokenBtn = document.getElementById('toggleToken');
    const loginSection = document.getElementById('loginSection');
    const controlSection = document.getElementById('controlSection');
    const logContainer = document.getElementById('logContainer');
    const deletedCountElement = document.getElementById('deletedCount');
    const purgeStatusElement = document.getElementById('purgeStatus');
    const statusDot = document.querySelector('.status-dot');
    const statusText = document.querySelector('.status-text');
    const speedSlider = document.getElementById('speedSlider');
    const speedInput = document.getElementById('speedInput');
    const speedValue = document.getElementById('speedValue');
    const discordUsername = document.getElementById('discordUsername');

    // State variables
    let isLoggedIn = false;
    let isPurging = false;
    let deletedCount = 0;
    let purgeInterval = null;
    let messageWatcher = null;
    let token = '';
    let channelId = '';
    let lastMessageId = null;
    let deletionSpeed = 100; // Default speed in ms, lowered from 1100
    let lastCheckedMessageId = null;
    let userData = null;
    let currentUserId = null;
    let knownMessageIds = new Set(); // Track message IDs we've seen to avoid duplicates
    let consecutiveErrors = 0; // Track consecutive errors to handle potential issues
    let emptyBatchCount = 0; // Track empty batches to reduce log spam
    let isRateLimited = false; // Track if we're currently rate limited
    let rateLimitResetTime = null; // When the rate limit resets
    let noMessagesFoundCount = 0; // Track how many times we've found no messages
    let isSearchingOlderMessages = true; // Whether we're searching older messages
    let isSearchingNewerMessages = true; // Whether we're searching newer messages
    let firstMessageId = null; // Track the first message ID for searching newer messages

    // Initialize speed controls with lower minimum
    speedSlider.min = 10; // Allow much lower delay
    speedInput.min = 10;
    speedSlider.value = 100;
    speedInput.value = 100;
    updateSpeed();

    // Initialize speed controls
    speedSlider.addEventListener('input', updateSpeed);
    speedInput.addEventListener('change', updateSpeedFromInput);

    // Setup Discord username copying
    if (discordUsername) {
        discordUsername.addEventListener('click', function() {
            const username = this.textContent;
            navigator.clipboard.writeText(username)
                .then(() => {
                    // Show copied message
                    this.parentElement.classList.add('copied');
                    // Change tooltip text
                    const tooltip = this.parentElement.querySelector('.copy-tooltip');
                    if (tooltip) {
                        tooltip.textContent = 'Copied!';
                    }
                    
                    setTimeout(() => {
                        this.parentElement.classList.remove('copied');
                        // Reset tooltip text
                        if (tooltip) {
                            tooltip.textContent = 'Click to copy';
                        }
                    }, 2000);
                })
                .catch(err => {
                    console.error('Could not copy text: ', err);
                    // Fallback for mobile
                    const textArea = document.createElement('textarea');
                    textArea.value = username;
                    document.body.appendChild(textArea);
                    textArea.focus();
                    textArea.select();
                    
                    try {
                        document.execCommand('copy');
                        this.parentElement.classList.add('copied');
                        setTimeout(() => {
                            this.parentElement.classList.remove('copied');
                        }, 2000);
                    } catch (err) {
                        console.error('Fallback copy failed: ', err);
                    }
                    
                    document.body.removeChild(textArea);
                });
        });
    }

    function updateSpeed() {
        deletionSpeed = parseInt(speedSlider.value);
        speedInput.value = deletionSpeed;
        let warningText = '';
        if (deletionSpeed < 100) {
            warningText = ' (Very low - may trigger rate limits)';
        } else if (deletionSpeed < 500) {
            warningText = ' (Low - may trigger rate limits)';
        }
        speedValue.textContent = `Current: ${deletionSpeed}ms${warningText}`;
    }

    function updateSpeedFromInput() {
        let value = parseInt(speedInput.value);
        // Clamp value between min and max
        value = Math.max(10, Math.min(5000, value));
        speedInput.value = value;
        speedSlider.value = value;
        deletionSpeed = value;
        let warningText = '';
        if (deletionSpeed < 100) {
            warningText = ' (Very low - may trigger rate limits)';
        } else if (deletionSpeed < 500) {
            warningText = ' (Low - may trigger rate limits)';
        }
        speedValue.textContent = `Current: ${deletionSpeed}ms${warningText}`;
    }

    // Toggle password visibility
    toggleTokenBtn.addEventListener('click', () => {
        const type = tokenInput.getAttribute('type') === 'password' ? 'text' : 'password';
        tokenInput.setAttribute('type', type);
        toggleTokenBtn.innerHTML = type === 'password' 
            ? '<i class="fas fa-eye"></i>' 
            : '<i class="fas fa-eye-slash"></i>';
    });

    // Channel ID change handling
    channelIdInput.addEventListener('change', () => {
        if (isPurging) {
            // If currently purging, update the channel ID and restart
            channelId = channelIdInput.value.trim();
            if (channelId) {
                addLogMessage('system', `Channel ID changed to: ${channelId}`);
                resetPurgeState();
                
                // If we're purging, restart the purge with the new channel
                if (isPurging) {
                    clearInterval(messageWatcher);
                    purgeMessages(); // Start historical purge again
                    startRealTimeWatcher();
                }
            }
        } else {
            channelId = channelIdInput.value.trim();
        }
    });

    // Reset purge state
    function resetPurgeState() {
        lastMessageId = null; // Reset pagination
        lastCheckedMessageId = null; // Reset real-time checking
        firstMessageId = null; // Reset first message ID
        knownMessageIds.clear(); // Clear known message IDs
        consecutiveErrors = 0; // Reset error counter
        emptyBatchCount = 0; // Reset empty batch counter
        noMessagesFoundCount = 0; // Reset no messages found counter
        isRateLimited = false; // Reset rate limit flag
        rateLimitResetTime = null; // Reset rate limit time
        isSearchingOlderMessages = true; // Reset searching older messages flag
        isSearchingNewerMessages = true; // Reset searching newer messages flag
    }

    // Login functionality
    loginBtn.addEventListener('click', async () => {
        token = tokenInput.value.trim();

        if (!token) {
            showNotification('Please enter your Discord token', 'error');
            return;
        }

        // Show loading state
        loginBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Logging in...';
        loginBtn.disabled = true;

        try {
            // Validate token by making a test request to Discord API
            const response = await fetch('https://discord.com/api/v10/users/@me', {
                headers: {
                    'Authorization': token
                }
            });

            if (!response.ok) {
                throw new Error(`Invalid token or API error: ${response.status}`);
            }

            userData = await response.json();
            currentUserId = userData.id; // Store the user's ID to filter messages
            
            // Login successful
            isLoggedIn = true;
            updateLoginStatus(true, userData.username);
            loginSection.classList.add('hidden');
            controlSection.classList.remove('hidden');
            
            // Clear any existing log messages
            clearLog();
            addLogMessage('system', `Logged in as ${userData.username} (ID: ${currentUserId})`);
            addLogMessage('system', 'Will only delete your own messages');
            
        } catch (error) {
            showNotification(error.message, 'error');
            loginBtn.innerHTML = 'Login';
            loginBtn.disabled = false;
        }
    });

    // Start purging messages
    startBtn.addEventListener('click', () => {
        if (!isLoggedIn) return;
        
        channelId = channelIdInput.value.trim();
        
        if (!channelId) {
            showNotification('Please enter a channel ID', 'error');
            return;
        }
        
        isPurging = true;
        resetPurgeState();
        startBtn.disabled = true;
        stopBtn.disabled = false;
        purgeStatusElement.textContent = 'Running';
        
        addLogMessage('system', `Connected to channel ID: ${channelId}`);
        addLogMessage('system', 'Started purging messages');
        
        // Start the purge process for existing messages
        purgeMessages();
        
        // Start real-time watcher for new messages
        startRealTimeWatcher();
    });

    // Stop purging messages
    stopBtn.addEventListener('click', () => {
        isPurging = false;
        clearInterval(messageWatcher);
        
        startBtn.disabled = false;
        stopBtn.disabled = true;
        purgeStatusElement.textContent = 'Stopped';
        
        addLogMessage('system', 'Stopped purging messages');
    });

    // Clear log
    clearLogBtn.addEventListener('click', clearLog);

    // Function to start real-time message watcher
    function startRealTimeWatcher() {
        // Clear any existing watcher
        if (messageWatcher) {
            clearInterval(messageWatcher);
        }
        
        // Check for new messages every 500ms for better real-time detection
        messageWatcher = setInterval(checkForNewMessages, 500);
    }
    
    // Function to check for new messages in real-time
    async function checkForNewMessages() {
        if (!isPurging || !channelId) return;
        
        // If we're rate limited, check if we can resume
        if (isRateLimited) {
            if (Date.now() < rateLimitResetTime) {
                // Still rate limited, update status
                const secondsLeft = Math.ceil((rateLimitResetTime - Date.now()) / 1000);
                purgeStatusElement.textContent = `Rate limited (${secondsLeft}s)`;
                return;
            } else {
                // Rate limit expired
                isRateLimited = false;
                rateLimitResetTime = null;
                purgeStatusElement.textContent = 'Running';
                addLogMessage('system', 'Rate limit expired, resuming operations');
            }
        }
        
        try {
            // Fetch latest messages from the channel
            const url = `https://discord.com/api/v10/channels/${channelId}/messages?limit=50`;
            
            const response = await fetch(url, {
                headers: {
                    'Authorization': token
                }
            });

            if (!response.ok) {
                // Check for rate limiting
                if (response.status === 429) {
                    const rateLimit = await response.json();
                    const retryAfter = rateLimit.retry_after || 5;
                    handleRateLimit(retryAfter);
                    return;
                }
                
                throw new Error(`API error: ${response.status}`);
            }

            const messages = await response.json();
            
            if (messages.length === 0) return;
            
            // If this is our first check, store the first message ID
            if (!firstMessageId && messages.length > 0) {
                firstMessageId = messages[0].id;
            }
            
            // If this is our first check, just store the latest message IDs
            if (!lastCheckedMessageId) {
                lastCheckedMessageId = messages[0].id;
                // Add all current message IDs to our known set
                messages.forEach(msg => knownMessageIds.add(msg.id));
                return;
            }
            
            // Find new messages (messages that we haven't seen before)
            const newMessages = [];
            
            for (const message of messages) {
                // If we've already processed this message, skip it
                if (knownMessageIds.has(message.id)) {
                    continue;
                }
                
                // Add this message ID to our known set
                knownMessageIds.add(message.id);
                
                // Only add messages from the current user
                if (message.author.id === currentUserId) {
                    newMessages.push(message);
                }
            }
            
            // Update the last checked message ID
            if (messages.length > 0) {
                lastCheckedMessageId = messages[0].id;
            }
            
            // If there are new messages, delete them
            if (newMessages.length > 0) {
                addLogMessage('system', `Found ${newMessages.length} new message(s) from you to delete`);
                
                // Delete each new message
                for (const message of newMessages) {
                    if (!isPurging) break;
                    if (isRateLimited) break;
                    
                    try {
                        const deleteResponse = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages/${message.id}`, {
                            method: 'DELETE',
                            headers: {
                                'Authorization': token
                            }
                        });

                        if (deleteResponse.status === 204) {
                            // Message deleted successfully
                            deletedCount++;
                            deletedCountElement.textContent = deletedCount;
                            consecutiveErrors = 0; // Reset error counter on success
                            
                            // Add to log
                            addLogMessage(
                                'deleted', 
                                message.content || '[No text content]', 
                                message.author.username || 'Unknown user',
                                new Date(),
                                true // Mark as real-time deletion
                            );
                            
                            // Wait according to user-defined speed
                            await new Promise(resolve => setTimeout(resolve, deletionSpeed));
                        } else if (deleteResponse.status === 429) {
                            // Rate limited
                            const rateLimit = await deleteResponse.json();
                            const retryAfter = rateLimit.retry_after || 5;
                            handleRateLimit(retryAfter);
                            break;
                        } else {
                            // Other error
                            addLogMessage('system', `Failed to delete message: ${deleteResponse.status} - ${message.id}`);
                            consecutiveErrors++;
                            
                            // If we get too many consecutive errors, wait a bit longer
                            if (consecutiveErrors > 5) {
                                addLogMessage('system', 'Too many consecutive errors. Waiting 10 seconds...');
                                await new Promise(resolve => setTimeout(resolve, 10000));
                                consecutiveErrors = 0;
                            }
                        }
                    } catch (error) {
                        addLogMessage('system', `Error deleting message: ${error.message}`);
                        consecutiveErrors++;
                    }
                }
            }
            
            // Limit the size of knownMessageIds to prevent memory issues
            if (knownMessageIds.size > 1000) {
                // Convert to array, keep only the most recent 500 IDs
                const messageIdsArray = Array.from(knownMessageIds);
                knownMessageIds = new Set(messageIdsArray.slice(messageIdsArray.length - 500));
            }
            
        } catch (error) {
            addLogMessage('system', `Error checking for new messages: ${error.message}`);
            consecutiveErrors++;
            
            // If we get too many consecutive errors, wait a bit longer
            if (consecutiveErrors > 5) {
                addLogMessage('system', 'Too many consecutive errors. Waiting 10 seconds...');
                await new Promise(resolve => setTimeout(resolve, 10000));
                consecutiveErrors = 0;
            }
        }
    }

    // Function to handle rate limiting
    function handleRateLimit(retryAfter) {
        isRateLimited = true;
        rateLimitResetTime = Date.now() + (retryAfter * 1000);
        
        const readableTime = new Date(rateLimitResetTime).toLocaleTimeString();
        addLogMessage('system', `Rate limited. Resuming at ${readableTime} (${retryAfter} seconds)`);
        purgeStatusElement.textContent = `Rate limited (${retryAfter}s)`;
    }

    // Function to update login status in UI
    function updateLoginStatus(isLoggedIn, username = '') {
        if (isLoggedIn) {
            statusDot.classList.remove('offline');
            statusDot.classList.add('online');
            statusText.textContent = `Logged in${username ? ` as ${username}` : ''}`;
        } else {
            statusDot.classList.remove('online');
            statusDot.classList.add('offline');
            statusText.textContent = 'Not logged in';
        }
    }

    // Function to show notification
    function showNotification(message, type = 'info') {
        // Simple alert for now, could be enhanced with a toast notification
        alert(message);
    }

    // Function to add a log message
    function addLogMessage(type, content, author = '', timestamp = new Date(), isRealTime = false) {
        // Remove empty log message if present
        const emptyMessage = logContainer.querySelector('.empty-log-message');
        if (emptyMessage) {
            logContainer.removeChild(emptyMessage);
        }

        const logItem = document.createElement('div');
        logItem.className = 'log-item';
        
        if (type === 'deleted') {
            logItem.innerHTML = `
                <div class="message-content">${escapeHtml(content)}${isRealTime ? ' <span style="color: var(--success-color);">[Real-time]</span>' : ''}</div>
                <div class="message-meta">
                    <span>${author}</span>
                    <span>${formatTimestamp(timestamp)}</span>
                </div>
            `;
        } else {
            logItem.innerHTML = `
                <div class="message-content">${content}</div>
                <div class="message-meta">
                    <span>System</span>
                    <span>${formatTimestamp(timestamp)}</span>
                </div>
            `;
        }
        
        logContainer.insertBefore(logItem, logContainer.firstChild);
        
        // Auto-scroll to bottom
        logContainer.scrollTop = 0;
    }

    // Function to clear the log
    function clearLog() {
        logContainer.innerHTML = '<div class="empty-log-message">No messages deleted yet</div>';
    }

    // Function to format timestamp
    function formatTimestamp(date) {
        return date.toLocaleTimeString() + ' ' + date.toLocaleDateString();
    }

    // Function to escape HTML
    function escapeHtml(unsafe) {
        return unsafe
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    // Function to purge messages
    async function purgeMessages() {
        if (!isPurging) return;
        
        // If we're rate limited, check if we can resume
        if (isRateLimited) {
            if (Date.now() < rateLimitResetTime) {
                // Still rate limited, try again later
                setTimeout(purgeMessages, 1000);
                return;
            } else {
                // Rate limit expired
                isRateLimited = false;
                rateLimitResetTime = null;
                purgeStatusElement.textContent = 'Running';
                addLogMessage('system', 'Rate limit expired, resuming operations');
            }
        }

        try {
            // Update status to show we're searching
            purgeStatusElement.textContent = 'Searching...';
            
            // Determine which direction to search
            let url;
            if (isSearchingOlderMessages) {
                // Search for older messages
                url = `https://discord.com/api/v10/channels/${channelId}/messages?limit=100${lastMessageId ? `&before=${lastMessageId}` : ''}`;
            } else if (isSearchingNewerMessages && firstMessageId) {
                // Search for newer messages
                url = `https://discord.com/api/v10/channels/${channelId}/messages?limit=100&after=${firstMessageId}`;
            } else {
                // If we're not searching in either direction, restart from the beginning
                resetPurgeState();
                url = `https://discord.com/api/v10/channels/${channelId}/messages?limit=100`;
            }
            
            const response = await fetch(url, {
                headers: {
                    'Authorization': token
                }
            });

            if (!response.ok) {
                // Check for rate limiting
                if (response.status === 429) {
                    const rateLimit = await response.json();
                    const retryAfter = rateLimit.retry_after || 5;
                    handleRateLimit(retryAfter);
                    setTimeout(purgeMessages, retryAfter * 1000 + 100);
                    return;
                }
                
                throw new Error(`API error: ${response.status}`);
            }

            const messages = await response.json();
            
            // If no messages found in current direction
            if (messages.length === 0) {
                noMessagesFoundCount++;
                
                // If we're searching older messages and found none, switch to newer messages
                if (isSearchingOlderMessages) {
                    isSearchingOlderMessages = false;
                    isSearchingNewerMessages = true;
                    purgeStatusElement.textContent = 'Switching to newer messages...';
                    setTimeout(purgeMessages, 100);
                    return;
                }
                
                // If we're searching newer messages and found none, switch back to older messages
                if (isSearchingNewerMessages) {
                    isSearchingNewerMessages = false;
                    isSearchingOlderMessages = true;
                    purgeStatusElement.textContent = 'Switching to older messages...';
                    setTimeout(purgeMessages, 100);
                    return;
                }
                
                // If we've searched in both directions and found nothing multiple times,
                // wait a bit longer before trying again
                if (noMessagesFoundCount > 5) {
                    purgeStatusElement.textContent = 'Waiting for new messages...';
                    noMessagesFoundCount = 0;
                    setTimeout(purgeMessages, 3000);
                    return;
                }
                
                // Otherwise, just continue searching
                setTimeout(purgeMessages, 100);
                return;
            }

            // Reset no messages found counter since we found messages
            noMessagesFoundCount = 0;
            
            // Update message IDs for pagination
            if (isSearchingOlderMessages && messages.length > 0) {
                lastMessageId = messages[messages.length - 1].id;
            }
            
            if (isSearchingNewerMessages && messages.length > 0) {
                firstMessageId = messages[0].id;
            }
            
            // Add all message IDs to our known set
            messages.forEach(msg => knownMessageIds.add(msg.id));
            
            // Filter messages to only include those from the current user
            const userMessages = messages.filter(message => message.author.id === currentUserId);
            
            if (userMessages.length === 0) {
                // Don't spam log with "no messages" - just continue to next batch
                purgeStatusElement.textContent = 'Searching...';
                // Continue with next batch immediately
                setTimeout(purgeMessages, 100);
                return;
            }
            
            // Update status to show we're deleting
            purgeStatusElement.textContent = 'Deleting...';
            addLogMessage('system', `Found ${userMessages.length} of your messages to delete`);
            
            // Delete each message
            for (const message of userMessages) {
                if (!isPurging) break;
                if (isRateLimited) break;
                
                try {
                    const deleteResponse = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages/${message.id}`, {
                        method: 'DELETE',
                        headers: {
                            'Authorization': token
                        }
                    });

                    if (deleteResponse.status === 204) {
                        // Message deleted successfully
                        deletedCount++;
                        deletedCountElement.textContent = deletedCount;
                        consecutiveErrors = 0; // Reset error counter on success
                        
                        // Add to log
                        addLogMessage(
                            'deleted', 
                            message.content || '[No text content]', 
                            message.author.username || 'Unknown user'
                        );
                        
                        // Wait according to user-defined speed
                        await new Promise(resolve => setTimeout(resolve, deletionSpeed));
                    } else if (deleteResponse.status === 429) {
                        // Rate limited
                        const rateLimit = await deleteResponse.json();
                        const retryAfter = rateLimit.retry_after || 5;
                        handleRateLimit(retryAfter);
                        
                        // Try again after rate limit expires
                        setTimeout(purgeMessages, retryAfter * 1000 + 100);
                        return;
                    } else {
                        // Other error
                        addLogMessage('system', `Failed to delete message: ${deleteResponse.status} - ${message.id}`);
                        consecutiveErrors++;
                        
                        // If we get too many consecutive errors, wait a bit longer
                        if (consecutiveErrors > 5) {
                            addLogMessage('system', 'Too many consecutive errors. Waiting 10 seconds...');
                            await new Promise(resolve => setTimeout(resolve, 10000));
                            consecutiveErrors = 0;
                        }
                    }
                } catch (error) {
                    addLogMessage('system', `Error deleting message: ${error.message}`);
                    consecutiveErrors++;
                }
            }
            
            // Continue with next batch after a short delay
            if (isPurging && !isRateLimited) {
                purgeStatusElement.textContent = 'Searching...';
                setTimeout(purgeMessages, 100);
            } else if (isRateLimited) {
                // If rate limited, the handleRateLimit function will set a timeout
                // to call purgeMessages again after the rate limit expires
            }
            
        } catch (error) {
            addLogMessage('system', `Error fetching messages: ${error.message}`);
            consecutiveErrors++;
            
            // Don't stop purging on error, just log it and retry after a delay
            if (isPurging) {
                // If we get too many consecutive errors, wait longer
                if (consecutiveErrors > 5) {
                    addLogMessage('system', 'Too many consecutive errors. Waiting 10 seconds...');
                    setTimeout(purgeMessages, 10000);
                    consecutiveErrors = 0;
                } else {
                    setTimeout(purgeMessages, 5000); // Retry after 5 seconds
                }
            }
        }
    }
});