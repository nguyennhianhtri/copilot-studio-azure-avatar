// Global variables
let avatarSynthesizer;
let avatarConfig;
let speechConfig;
let recognizer;
let isRecognizing = false;
let socket;
let audioContext;
let isFirstResponseChunk;
let speechRecognizer;
let peerConnection;
let isSpeaking = false;
let sessionActive = false;
let recognitionStartedTime;
let chatRequestSentTime;
let chatResponseReceivedTime;
let lastSpeakTime;
let isFirstRecognizingEvent = true;

// Variables for the new Speech SDK approach
let clientId;
let lastInteractionTime = new Date();
let userClosedSession = false;

// Update microphone status
function updateMicStatus(message, isError = false) {
    const statusElement = document.getElementById('micStatus');
    statusElement.textContent = message;
    statusElement.style.color = isError ? 'red' : '#666';
    console.log(`Microphone Status: ${message}`);
}

// Initialize client ID and fetch ICE token
function initializeClientId() {
    clientId = document.getElementById('clientId')?.value;
    if (!clientId) {
        clientId = `client_${Math.random().toString(36).substr(2, 9)}`;
        console.warn('Client ID not found in DOM, generated:', clientId);
    } else {
        console.log('Client ID initialized:', clientId);
    }
}

// Initialize everything when page loads
window.onload = () => {
    initializeClientId();
    // Initialize speech configuration when page loads
    initializeSpeechConfig();
    
    // Fetch ICE token and prepare peer connection on page load
    fetchIceToken(); 
    setInterval(fetchIceToken, 60 * 1000); // Fetch ICE token and prepare peer connection every 1 minute
};

// Initialize speech configuration
async function initializeSpeechConfig() {
    if (!window.SpeechSDK) {
        updateMicStatus('Waiting for Speech SDK to load...');
        await new Promise(resolve => {
            const checkSDK = setInterval(() => {
                if (window.SpeechSDK) {
                    clearInterval(checkSDK);
                    resolve();
                }
            }, 100);
        });
    }

    if (!SPEECH_CONFIG.region || !SPEECH_CONFIG.key) {
        updateMicStatus('Speech configuration is missing from environment variables', true);
        return false;
    }

    try {
        // Initialize speech config
        speechConfig = window.SpeechSDK.SpeechConfig.fromSubscription(SPEECH_CONFIG.key, SPEECH_CONFIG.region);
        speechConfig.speechRecognitionLanguage = 'en-US';
        
        // Initialize avatar config
        avatarConfig = {
            character: document.getElementById('avatarCharacter').value,
            style: document.getElementById('avatarStyle').value
        };
        
        updateMicStatus('Speech configuration initialized successfully');
        return true;
    } catch (error) {
        console.error('Error initializing speech config:', error);
        updateMicStatus(`Error initializing speech config: ${error.message}`, true);
        return false;
    }
}

// Initialize speech recognition
async function initializeSpeechRecognition() {
    if (!await initializeSpeechConfig()) {
        return false;
    }

    try {
        // Request microphone permission
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach(track => track.stop()); // Stop the stream after getting permission
        
        // Create audio config
        const audioConfig = window.SpeechSDK.AudioConfig.fromDefaultMicrophoneInput();
        
        // Create recognizer
        recognizer = new window.SpeechSDK.SpeechRecognizer(speechConfig, audioConfig);
        
        // Set up recognition events
        recognizer.recognized = (s, e) => {
            if (e.result.reason === window.SpeechSDK.ResultReason.RecognizedSpeech) {
                const text = e.result.text;
                if (text) {
                    updateMicStatus(`Recognized: ${text}`);
                    handleChatMessage(text);
                }
            }
        };
        
        recognizer.canceled = (s, e) => {
            console.log(`Speech recognition canceled: ${e.reason}`);
            if (e.reason === window.SpeechSDK.CancellationReason.Error) {
                console.error(`Error details: ${e.errorDetails}`);
                updateMicStatus(`Error: ${e.errorDetails}`, true);
            }
            stopRecognition();
        };
        
        recognizer.sessionStopped = (s, e) => {
            console.log('Speech recognition session stopped');
            updateMicStatus('Speech recognition stopped');
            stopRecognition();
        };
        
        updateMicStatus('Speech recognition initialized successfully');
        return true;
    } catch (error) {
        console.error('Error initializing speech recognition:', error);
        updateMicStatus(`Error initializing speech recognition: ${error.message}`, true);
        return false;
    }
}

// Start speech recognition
async function startRecognition() {
    try {
        if (!recognizer) {
            if (!await initializeSpeechRecognition()) {
                return;
            }
        }
        
        await recognizer.startContinuousRecognitionAsync();
        isRecognizing = true;
        document.getElementById('startMicButton').disabled = true;
        document.getElementById('stopMicButton').disabled = false;
        document.getElementById('recordingIndicator').style.display = 'inline';
        updateMicStatus('Listening...');
    } catch (error) {
        console.error('Error starting recognition:', error);
        updateMicStatus(`Error starting recognition: ${error.message}`, true);
    }
}

// Stop speech recognition
function stopRecognition() {
    if (recognizer && isRecognizing) {
        recognizer.stopContinuousRecognitionAsync();
        isRecognizing = false;
        document.getElementById('startMicButton').disabled = false;
        document.getElementById('stopMicButton').disabled = true;
        document.getElementById('recordingIndicator').style.display = 'none';
        updateMicStatus('Microphone stopped');
    }
}

// Speak text with avatar using server-side API
async function speakWithAvatar(text) {
    if (!sessionActive) {
        console.warn('Avatar session not active. Cannot speak.');
        return;
    }

    if (!text || text.trim() === '') {
        console.warn('Empty text. Nothing to speak.');
        return;
    }

    try {
        console.log('Avatar speaking:', text);
        isSpeaking = true;
        document.getElementById('stopAvatarButton').disabled = false;

        // Get CSRF token
        const csrfToken = document.querySelector('meta[name="csrf-token"]').getAttribute('content');

        // Get voice configuration from UI
        const isCustomVoice = document.getElementById('isCustomVoice').checked;
        let voiceName;
        
        if (isCustomVoice) {
            voiceName = document.getElementById('customTtsVoice').value || 'en-US-JennyNeural';
        } else {
            voiceName = document.getElementById('ttsVoice').value || 'en-US-JennyNeural';
        }

        // Convert text to SSML format with selected voice
        const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">
            <voice name="${voiceName}">${text}</voice>
        </speak>`;

        // Send speak request to server with SSML as raw text data
        const response = await fetch('/api/speak', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/ssml+xml',
                'X-CSRFToken': csrfToken,
                'ClientId': clientId
            },
            body: ssml  // Send SSML as raw text, not JSON
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP error! status: ${response.status}, message: ${errorText}`);
        }

        const result = await response.text();
        console.log("Avatar speech initiated successfully:", result);

        // Note: The actual speaking happens on the server and is streamed via WebRTC
        // We don't get immediate feedback when speaking completes, so we'll set a timeout
        // In a production app, you might want to add a callback mechanism
        setTimeout(() => {
            isSpeaking = false;
            document.getElementById('stopAvatarButton').disabled = true;
        }, text.length * 50); // Rough estimate: 50ms per character

    } catch (error) {
        console.error('Error in speakWithAvatar:', error);
        isSpeaking = false;
        document.getElementById('stopAvatarButton').disabled = true;
        throw error;
    }
}

// Stop the avatar from speaking
// Stop the avatar from speaking using server-side API
async function stopAvatarSpeaking() {
    if (!isSpeaking) return;
    
    try {
        console.log('Stopping avatar speaking...');
        
        // Get CSRF token
        const csrfToken = document.querySelector('meta[name="csrf-token"]').getAttribute('content');
        
        // Send stop speaking request to server
        const response = await fetch('/api/stopSpeaking', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRFToken': csrfToken,
                'ClientId': clientId
            }
        });

        if (response.ok) {
            console.log('Successfully stopped avatar speaking');
            isSpeaking = false;
            document.getElementById('stopAvatarButton').disabled = true;
        } else {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
    } catch (error) {
        console.error('Error stopping avatar speaking:', error);
        isSpeaking = false;
        document.getElementById('stopAvatarButton').disabled = true;
    }
}

// Update the handleChatMessage function to use the avatar for speech
async function handleChatMessage(message) {
    try {
        
        // Stop speaking if already speaking
        if (isSpeaking) {
            stopAvatarSpeaking();
        }

        // Display user message on the right side
        displayMessage(message, 'user', 'right');
        
        // Show typing indicator
        document.getElementById('typingIndicator').style.display = 'block';
        
        // Get CSRF token
        const csrfToken = document.querySelector('meta[name="csrf-token"]').getAttribute('content');
        
        // Send message to server
        const response = await fetch('/chat', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRFToken': csrfToken
            },
            body: JSON.stringify({ message })
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        console.log('Bot response data:', data);

        // Extract bot's response text from the Direct Line activity
        let botResponse;
        if (data.text) {
            // Direct Line activity format
            botResponse = data.text;
        } else if (data.activities && data.activities.length > 0) {
            // Find the first bot response activity
            const botActivity = data.activities.find(activity => 
                activity.type === 'message' && 
                activity.from && 
                activity.from.role === 'bot'
            );
            
            if (botActivity && botActivity.text) {
                botResponse = botActivity.text;
            } else {
                throw new Error('No bot message found in activities');
            }
        } else if (data.response) {
            // Fallback to direct response field
            botResponse = data.response;
        } else {
            throw new Error('No response text found in bot response');
        }

        if (!botResponse) {
            throw new Error('Bot response is empty');
        }

        // Clean up the response text if needed
        botResponse = botResponse.replace(/\\r\\n/g, '\n').trim();

        // Separate the main response from the disclaimer
        let mainResponse = botResponse;
        let disclaimer = '';
        
        // Check for AI-generated content disclaimer
        const disclaimerPattern = /(AI-generated content may be incorrect|AI-generated content disclaimer)/i;
        if (disclaimerPattern.test(botResponse)) {
            const parts = botResponse.split(disclaimerPattern);
            mainResponse = parts[0].trim();
            disclaimer = parts[1] ? parts[1].trim() : '';
        }

        // Display bot's main response on the left side
        displayMessage(mainResponse, 'bot', 'left');
        
        // Display disclaimer as a footnote if it exists
        if (disclaimer) {
            displayMessage(disclaimer, 'disclaimer', 'left');
        }

        // Hide typing indicator
        document.getElementById('typingIndicator').style.display = 'none';

        // Speak the response with avatar
        if (sessionActive) {
            speakWithAvatar(mainResponse);
        }

    } catch (error) {
        console.error('Error handling chat message:', error);
        document.getElementById('typingIndicator').style.display = 'none';
        displayMessage(`Error: ${error.message}`, 'system', 'left');
    }
}

// Update displayMessage function to handle alignment
function displayMessage(message, sender, alignment = 'left') {
    const chatMessages = document.getElementById('chatMessages');
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${sender}-message ${alignment}-aligned`;
    
    if (sender === 'disclaimer') {
        messageDiv.className += ' disclaimer';
    }
    
    messageDiv.textContent = message;
    chatMessages.appendChild(messageDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

// Initialize chat when document is loaded
document.addEventListener('DOMContentLoaded', () => {
    // Set up message form
    const messageForm = document.querySelector('.message-form');
    const messageInput = document.getElementById('messageInput');
    const sendButton = document.getElementById('sendButton');
    
    messageForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const message = messageInput.value.trim();
        if (message) {
            handleChatMessage(message);
            messageInput.value = '';
        }
    });
    
    sendButton.addEventListener('click', () => {
        const message = messageInput.value.trim();
        if (message) {
            handleChatMessage(message);
            messageInput.value = '';
        }
    });
    
    // Set up microphone controls
    const startMicButton = document.getElementById('startMicButton');
    const stopMicButton = document.getElementById('stopMicButton');
    
    startMicButton.addEventListener('click', startRecognition);
    stopMicButton.addEventListener('click', stopRecognition);

    // Voice settings handlers
    const ttsVoice = document.getElementById('ttsVoice');
    const customTtsVoice = document.getElementById('customTtsVoice');
    const isCustomVoice = document.getElementById('isCustomVoice');

    // Handle custom voice checkbox
    isCustomVoice.addEventListener('change', function() {
        const isCustom = this.checked;
        ttsVoice.disabled = isCustom;
        customTtsVoice.style.display = isCustom ? 'block' : 'none';
    });

    // Handle custom voice selection
    ttsVoice.addEventListener('change', function() {
        customTtsVoice.style.display = this.value === 'custom' ? 'block' : 'none';
    });
});

// Connect to avatar service
// Create speech recognizer
function createSpeechRecognizer() {
    fetch('/api/getSpeechToken', {
        method: 'GET',
    })
    .then(response => {
        if (response.ok) {
            const speechRegion = response.headers.get('SpeechRegion');
            const speechPrivateEndpoint = response.headers.get('SpeechPrivateEndpoint');
            response.text().then(text => {
                const speechToken = text;
                const speechRecognitionConfig = speechPrivateEndpoint ?
                    SpeechSDK.SpeechConfig.fromEndpoint(new URL(`wss://${speechPrivateEndpoint.replace('https://', '')}/stt/speech/universal/v2`), '') :
                    SpeechSDK.SpeechConfig.fromEndpoint(new URL(`wss://${speechRegion}.stt.speech.microsoft.com/speech/universal/v2`), '');
                speechRecognitionConfig.authorizationToken = speechToken;
                speechRecognitionConfig.setProperty(SpeechSDK.PropertyId.SpeechServiceConnection_LanguageIdMode, "Continuous");
                speechRecognitionConfig.setProperty("SpeechContext-PhraseDetection.TrailingSilenceTimeout", "3000");
                speechRecognitionConfig.setProperty("SpeechContext-PhraseDetection.InitialSilenceTimeout", "10000");
                speechRecognitionConfig.setProperty("SpeechContext-PhraseDetection.Dictation.Segmentation.Mode", "Custom");
                speechRecognitionConfig.setProperty("SpeechContext-PhraseDetection.Dictation.Segmentation.SegmentationSilenceTimeoutMs", "200");
                var sttLocales = document.getElementById('sttLocales').value.split(',');
                var autoDetectSourceLanguageConfig = SpeechSDK.AutoDetectSourceLanguageConfig.fromLanguages(sttLocales);
                speechRecognizer = SpeechSDK.SpeechRecognizer.FromConfig(speechRecognitionConfig, autoDetectSourceLanguageConfig, SpeechSDK.AudioConfig.fromDefaultMicrophoneInput());
            });
        } else {
            throw new Error(`Failed fetching speech token: ${response.status} ${response.statusText}`);
        }
    });
}

// Handle microphone button click
window.microphone = () => {
    if (document.getElementById('microphone').innerHTML === 'Stop Microphone') {
        // Stop microphone
        document.getElementById('microphone').disabled = true;
        speechRecognizer.stopContinuousRecognitionAsync(
            () => {
                document.getElementById('microphone').innerHTML = 'Start Microphone';
                document.getElementById('microphone').disabled = false;
            }, (err) => {
                console.log("Failed to stop continuous recognition:", err);
                document.getElementById('microphone').disabled = false;
            });
        return;
    }

    // Start microphone
    document.getElementById('microphone').disabled = true;
    speechRecognizer.recognizing = async (s, e) => {
        if (isFirstRecognizingEvent && isSpeaking) {
            stopAvatarSpeaking();
            isFirstRecognizingEvent = false;
        }
    };

    speechRecognizer.recognized = async (s, e) => {
        if (e.result.reason === SpeechSDK.ResultReason.RecognizedSpeech) {
            let userQuery = e.result.text.trim();
            if (userQuery === '') {
                return;
            }

            let recognitionResultReceivedTime = new Date();
            let speechFinishedOffset = (e.result.offset + e.result.duration) / 10000;
            let sttLatency = recognitionResultReceivedTime - recognitionStartedTime - speechFinishedOffset;
            console.log(`STT latency: ${sttLatency} ms`);
            let latencyLogTextArea = document.getElementById('latencyLog');
            latencyLogTextArea.innerHTML += `STT latency: ${sttLatency} ms\n`;
            latencyLogTextArea.scrollTop = latencyLogTextArea.scrollHeight;

            // Auto stop microphone when a phrase is recognized, when it's not continuous conversation mode
            if (!document.getElementById('continuousConversation').checked) {
                document.getElementById('microphone').disabled = true;
                speechRecognizer.stopContinuousRecognitionAsync(
                    () => {
                        document.getElementById('microphone').innerHTML = 'Start Microphone';
                        document.getElementById('microphone').disabled = false;
                    }, (err) => {
                        console.log("Failed to stop continuous recognition:", err);
                        document.getElementById('microphone').disabled = false;
                    });
            }

            let chatHistoryTextArea = document.getElementById('chatHistory');
            if (chatHistoryTextArea.innerHTML !== '' && !chatHistoryTextArea.innerHTML.endsWith('\n\n')) {
                chatHistoryTextArea.innerHTML += '\n\n';
            }

            chatHistoryTextArea.innerHTML += "User: " + userQuery + '\n\n';
            chatHistoryTextArea.scrollTop = chatHistoryTextArea.scrollHeight;

            handleChatMessage(userQuery);

            isFirstRecognizingEvent = true;
        }
    };

    recognitionStartedTime = new Date();
    speechRecognizer.startContinuousRecognitionAsync(
        () => {
            document.getElementById('microphone').innerHTML = 'Stop Microphone';
            document.getElementById('microphone').disabled = false;
        }, (err) => {
            console.log("Failed to start continuous recognition:", err);
            document.getElementById('microphone').disabled = false;
        });
};

// Global variables for peer connection management (matching Azure sample)
let iceServerUrl, iceServerUsername, iceServerCredential;
let peerConnectionQueue = [];
let speechSynthesizerConnected = false;
let isReconnecting = false;

// Fetch ICE token from the server (matching Azure sample exactly)
function fetchIceToken() {
    fetch('/api/getIceToken', {
        method: 'GET',
    }).then(response => {
        if (response.ok) {
            response.json().then(data => {
                iceServerUrl = data.Urls[0];
                iceServerUsername = data.Username;
                iceServerCredential = data.Password;
                console.log(`[${new Date().toISOString()}] ICE token fetched.`);
                preparePeerConnection();
            });
        } else {
            console.error(`Failed fetching ICE token: ${response.status} ${response.statusText}`);
        }
    });
}

// Prepare peer connection for WebRTC (exactly as in Azure sample)
function preparePeerConnection() {
    // Create WebRTC peer connection
    let peerConn = new RTCPeerConnection({
        iceServers: [{
            urls: [ iceServerUrl ],
            username: iceServerUsername,
            credential: iceServerCredential
        }],
        iceTransportPolicy: 'relay'
    });

    // Fetch WebRTC video stream and mount it to an HTML video element
    peerConn.ontrack = function (event) {
        if (event.track.kind === 'audio') {
            let audioElement = document.createElement('audio');
            audioElement.id = 'audioPlayer';
            audioElement.srcObject = event.streams[0];
            audioElement.autoplay = true;

            audioElement.onplaying = () => {
                console.log(`WebRTC ${event.track.kind} channel connected.`);
            };

            // Clean up existing audio element if there is any
            let remoteVideoDiv = document.getElementById('remoteVideo');
            for (var i = 0; i < remoteVideoDiv.childNodes.length; i++) {
                if (remoteVideoDiv.childNodes[i].localName === event.track.kind) {
                    remoteVideoDiv.removeChild(remoteVideoDiv.childNodes[i]);
                }
            }

            // Append the new audio element
            document.getElementById('remoteVideo').appendChild(audioElement);
        }

        if (event.track.kind === 'video') {
            let videoElement = document.createElement('video');
            videoElement.id = 'videoPlayer';
            videoElement.srcObject = event.streams[0];
            videoElement.autoplay = true;
            videoElement.playsInline = true;
            videoElement.style.width = '0.5px';

            document.getElementById('remoteVideo').appendChild(videoElement);

            // Continue speaking if there are unfinished sentences while reconnecting
            if (isReconnecting) {
                fetch('/api/chat/continueSpeaking', {
                    method: 'POST',
                    headers: {
                        'ClientId': clientId
                    },
                    body: ''
                });
            }

            videoElement.onplaying = () => {
                // Clean up existing video element if there is any
                let remoteVideoDiv = document.getElementById('remoteVideo');
                for (var i = 0; i < remoteVideoDiv.childNodes.length; i++) {
                    if (remoteVideoDiv.childNodes[i].localName === event.track.kind) {
                        remoteVideoDiv.removeChild(remoteVideoDiv.childNodes[i]);
                    }
                }

                // Append the new video element
                videoElement.style.width = '960px';
                document.getElementById('remoteVideo').appendChild(videoElement);

                console.log(`WebRTC ${event.track.kind} channel connected.`);
                document.getElementById('microphone').disabled = false;
                document.getElementById('stopSession').disabled = false;
                document.getElementById('remoteVideo').style.width = '960px';
                document.getElementById('chatHistory').hidden = false;
                
                isReconnecting = false;
                setTimeout(() => { sessionActive = true }, 5000); // Set session active after 5 seconds
            };
        }
    };

    // Make necessary update to the web page when the connection state changes
    peerConn.oniceconnectionstatechange = e => {
        console.log("WebRTC status: " + peerConn.iceConnectionState);
        if (peerConn.iceConnectionState === 'disconnected') {
            document.getElementById('remoteVideo').style.width = '0.1px';
        }
    };

    // Offer to receive 1 audio, and 1 video track
    peerConn.addTransceiver('video', { direction: 'sendrecv' });
    peerConn.addTransceiver('audio', { direction: 'sendrecv' });

    // Connect to avatar service when ICE candidates gathering is done
    let iceGatheringDone = false;

    peerConn.onicecandidate = e => {
        if (!e.candidate && !iceGatheringDone) {
            iceGatheringDone = true;
            peerConnectionQueue.push(peerConn);
            console.log("[" + (new Date()).toISOString() + "] ICE gathering done, new peer connection prepared.");
            if (peerConnectionQueue.length > 1) {
                peerConnectionQueue.shift();
            }
        }
    };

    peerConn.createOffer().then(sdp => {
        peerConn.setLocalDescription(sdp).then(() => { 
            setTimeout(() => {
                if (!iceGatheringDone) {
                    iceGatheringDone = true;
                    peerConnectionQueue.push(peerConn);
                    console.log("[" + (new Date()).toISOString() + "] ICE gathering done, new peer connection prepared.");
                    if (peerConnectionQueue.length > 1) {
                        peerConnectionQueue.shift();
                    }
                }
            }, 10000) 
        })
    });
}

// Wait for peer connection and start session (exactly as in Azure sample)
function waitForPeerConnectionAndStartSession() {
    if (peerConnectionQueue.length > 0) {
        let peerConn = peerConnectionQueue.shift();
        connectToAvatarService(peerConn);
        if (peerConnectionQueue.length === 0) {
            preparePeerConnection();
        }
    } else {
        console.log("Waiting for peer connection to be ready...");
        setTimeout(waitForPeerConnectionAndStartSession, 1000);
    }
}

// Connect to TTS Avatar Service (exactly as in Azure sample)
function connectToAvatarService(peerConn) {
    let localSdp = btoa(JSON.stringify(peerConn.localDescription));
    
    // Get avatar configuration from UI
    const isCustom = document.getElementById('isCustomAvatar').checked;
    let avatarCharacter, avatarStyle;
    
    if (isCustom) {
        avatarCharacter = document.getElementById('customAvatarCharacter').value;
        avatarStyle = document.getElementById('customAvatarStyle').value;
    } else {
        avatarCharacter = document.getElementById('avatarCharacter').value;
        if (avatarCharacter === 'custom') {
            avatarCharacter = document.getElementById('customAvatarCharacter').value;
        }
        
        avatarStyle = document.getElementById('avatarStyle').value;
        if (avatarStyle === 'custom') {
            avatarStyle = document.getElementById('customAvatarStyle').value;
        }
    }

    const ttsVoice = document.getElementById('ttsVoice').value;

    let headers = {
        'ClientId': clientId,
        'AvatarCharacter': avatarCharacter,
        'AvatarStyle': avatarStyle,
        'IsCustomAvatar': isCustom
    };

    if (isReconnecting) {
        headers['Reconnect'] = true;
    }

    if (ttsVoice !== '') {
        headers['TtsVoice'] = ttsVoice;
    }

    fetch('/api/connectAvatar', {
        method: 'POST',
        headers: headers,
        body: localSdp
    })
    .then(response => {
        if (response.ok) {
            response.text().then(text => {
                const remoteSdp = text;
                peerConn.setRemoteDescription(new RTCSessionDescription(JSON.parse(atob(remoteSdp))));
            });
        } else {
            document.getElementById('startAvatarButton').disabled = false;
            throw new Error(`Failed connecting to the Avatar service: ${response.status} ${response.statusText}`);
        }
    });
}

// Connect avatar (matching Azure sample flow)
function connectAvatarService() {
    document.getElementById('startAvatarButton').disabled = true;
    waitForPeerConnectionAndStartSession();
    lastInteractionTime = new Date();
    userClosedSession = false;
}

// Disconnect from avatar service (matching Azure sample)
function disconnectAvatar(closeSpeechRecognizer = false) {
    fetch('/api/disconnectAvatar', {
        method: 'POST',
        headers: {
            'ClientId': clientId
        },
        body: ''
    });

    if (speechRecognizer !== undefined) {
        speechRecognizer.stopContinuousRecognitionAsync();
        if (closeSpeechRecognizer) {
            speechRecognizer.close();
        }
    }

    sessionActive = false;
}

// Initialize when page loads (matching Azure sample exactly)
// Start session function (matching Azure sample)
window.startSession = () => {
    lastInteractionTime = new Date();
    userClosedSession = false;
    connectAvatarService();
};

// Stop session function (matching Azure sample)
window.stopSession = () => {
    lastInteractionTime = new Date();
    document.getElementById('startAvatarButton').disabled = false;
    document.getElementById('microphone').disabled = true;
    document.getElementById('stopSession').disabled = true;
    document.getElementById('chatHistory').hidden = true;

    userClosedSession = true; // Indicating the session was closed by user on purpose, not due to network issue
    disconnectAvatar(true);
};

// Document ready function
document.addEventListener('DOMContentLoaded', function() {
    // Set up event listeners for UI controls
    
    // Avatar configuration handlers
    const avatarCharacter = document.getElementById('avatarCharacter');
    const customAvatarCharacter = document.getElementById('customAvatarCharacter');
    const avatarStyle = document.getElementById('avatarStyle');
    const customAvatarStyle = document.getElementById('customAvatarStyle');
    const isCustomAvatar = document.getElementById('isCustomAvatar');

    // Define available styles for each character
    const characterStyles = {
        'Harry': ['business', 'casual', 'youthful'],
        'Jeff': ['business', 'formal'],
        'Lisa': ['casual-sitting'],
        'Lori': ['casual', 'formal', 'graceful'],
        'Max': ['business', 'casual', 'formal'],
        'Meg': ['business', 'casual', 'formal']
    };

    // Function to update style options based on selected character
    function updateStyleOptions(character) {
        // Clear all existing options
        avatarStyle.innerHTML = '';

        // Add new options based on character
        if (character && characterStyles[character]) {
            characterStyles[character].forEach(style => {
                const option = document.createElement('option');
                option.value = style;
                option.textContent = style.charAt(0).toUpperCase() + style.slice(1).replace('-', ' ');
                avatarStyle.appendChild(option);
            });
        }
    }

    // Handle character selection change
    avatarCharacter.addEventListener('change', function() {
        const selectedCharacter = this.value;
        updateStyleOptions(selectedCharacter);
        customAvatarCharacter.style.display = this.value === 'custom' ? 'block' : 'none';
    });

    // Handle custom avatar checkbox
    isCustomAvatar.addEventListener('change', function() {
        const isCustom = this.checked;
        avatarCharacter.disabled = isCustom;
        avatarStyle.disabled = isCustom;
        customAvatarCharacter.style.display = isCustom ? 'block' : 'none';
        customAvatarStyle.style.display = isCustom ? 'block' : 'none';
    });

    // Initialize style options based on default character
    updateStyleOptions(avatarCharacter.value);

    // Avatar buttons - use the function names expected by Azure sample
    document.getElementById('startAvatarButton').addEventListener('click', function() {
        window.startSession();
    });
    
    document.getElementById('stopAvatarButton').addEventListener('click', function() {
        window.stopSession();
    });
    
    // Initialize with disabled mic button until speech SDK is ready
    document.getElementById('startMicButton').disabled = true;
    
    // Initialize speech config when page loads
    initializeSpeechConfig().then(() => {
        document.getElementById('startMicButton').disabled = false;
    });
});

