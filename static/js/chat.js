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

// Update microphone status
function updateMicStatus(message, isError = false) {
    const statusElement = document.getElementById('micStatus');
    statusElement.textContent = message;
    statusElement.style.color = isError ? 'red' : '#666';
    console.log(`Microphone Status: ${message}`);
}

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

// Speak text with avatar
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
        // Get voice settings from UI
        let ttsVoice;
        if (document.getElementById('isCustomVoice').checked) {
            ttsVoice = document.getElementById('customTtsVoice').value.trim();
            if (!ttsVoice) {
                throw new Error('Custom voice name cannot be empty');
            }
        } else {
            ttsVoice = document.getElementById('ttsVoice').value;
        }
        const customVoiceEndpointId = document.getElementById('customVoiceEndpointId').value || '';
        const personalVoiceSpeakerProfileID = document.getElementById('personalVoiceSpeakerProfileID').value || '';

        // Create SSML for speech
        const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xmlns:mstts='http://www.w3.org/2001/mstts' xml:lang='en-US'>
            <voice name='${ttsVoice}'>
                <mstts:ttsembedding speakerProfileId='${personalVoiceSpeakerProfileID}'>
                    <mstts:leadingsilence-exact value='0'/>
                    ${text}
                </mstts:ttsembedding>
            </voice>
        </speak>`;

        // Get CSRF token
        const csrfToken = document.querySelector('meta[name="csrf-token"]').getAttribute('content');
        
        // Send SSML to the server to speak through the avatar
        const response = await fetch('/api/speak', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/xml',
                'X-CSRFToken': csrfToken
            },
            body: ssml
        });

        if (!response.ok) {
            throw new Error(`Failed to speak text: ${response.statusText}`);
        }

        isSpeaking = true;
        document.getElementById('stopAvatarButton').disabled = false;
        console.log('Avatar speaking:', text);

    } catch (error) {
        console.error('Error in speakWithAvatar:', error);
    }
}

// Stop the avatar from speaking
function stopAvatarSpeaking() {
    if (!isSpeaking) return;
    
    const csrfToken = document.querySelector('meta[name="csrf-token"]').getAttribute('content');
    
    fetch('/api/stopSpeaking', {
        method: 'POST',
        headers: {
            'X-CSRFToken': csrfToken
        }
    })
    .then(response => {
        if (response.ok) {
            console.log('Successfully stopped avatar speaking');
        } else {
            console.error('Failed to stop avatar speaking:', response.statusText);
        }
    })
    .catch(error => {
        console.error('Error stopping avatar speaking:', error);
    });

    isSpeaking = false;
    document.getElementById('stopAvatarButton').disabled = true;
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
function connectAvatar() {
    document.getElementById('startSession').disabled = true;

    fetch('/api/getIceToken', {
        method: 'GET',
    })
    .then(response => {
        if (response.ok) {
            response.json().then(data => {
                const iceServerUrl = data.Urls[0];
                const iceServerUsername = data.Username;
                const iceServerCredential = data.Password;
                setupWebRTC(iceServerUrl, iceServerUsername, iceServerCredential);
            });
        } else {
            throw new Error(`Failed fetching ICE token: ${response.status} ${response.statusText}`);
        }
    });

    document.getElementById('configuration').hidden = true;
}

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
            window.stopSpeaking();
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

            handleUserQuery(userQuery);

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

// Set up WebRTC connection to avatar service
async function connectAvatarService() {
    try {
        // Get CSRF token
        const csrfToken = document.querySelector('meta[name="csrf-token"]').getAttribute('content');
        
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
        const customVoiceEndpointId = document.getElementById('customVoiceEndpointId').value;
        const personalVoiceSpeakerProfileID = document.getElementById('personalVoiceSpeakerProfileID').value;

        console.log("Connecting to avatar service with parameters:", {
            isCustom,
            avatarCharacter,
            avatarStyle,
            ttsVoice
        });

        // Get ICE token from server
        const iceTokenResponse = await fetch('/api/getIceToken', {
            method: 'GET',
            headers: {
                'X-CSRFToken': csrfToken
            }
        });

        if (!iceTokenResponse.ok) {
            throw new Error(`Failed to get ICE token: ${iceTokenResponse.status} ${iceTokenResponse.statusText}`);
        }

        const iceTokenText = await iceTokenResponse.text();
        let iceToken;
        try {
            iceToken = JSON.parse(iceTokenText);
        } catch (e) {
            console.error('Failed to parse ICE token:', e);
            throw new Error('Invalid ICE token format received from server');
        }
        
        console.log('ICE token retrieved successfully');

        // Create WebRTC peer connection
        peerConnection = new RTCPeerConnection({
            iceServers: [{
                urls: [ iceToken.Urls[0] ],
                username: iceToken.Username,
                credential: iceToken.Password
            }],
            iceTransportPolicy: 'relay'
        });

        // Handle incoming video and audio streams
        peerConnection.ontrack = function(event) {
            if (event.track.kind === 'video') {
                const videoElement = document.getElementById('avatarVideo');
                videoElement.srcObject = event.streams[0];
                
                videoElement.onplaying = () => {
                    console.log('Avatar video started playing');
                    document.getElementById('startAvatarButton').disabled = true;
                    document.getElementById('stopAvatarButton').disabled = false;
                    sessionActive = true;
                };
            }

            if (event.track.kind === 'audio') {
                const audioElement = document.createElement('audio');
                audioElement.id = 'avatarAudio';
                audioElement.srcObject = event.streams[0];
                audioElement.autoplay = true;
                
                // Append to document body but hide it
                audioElement.style.display = 'none';
                document.body.appendChild(audioElement);
                
                audioElement.onplaying = () => {
                    console.log('Avatar audio started playing');
                };
            }
        };

        // Listen for data channel events
        peerConnection.addEventListener("datachannel", event => {
            const dataChannel = event.channel;
            dataChannel.onmessage = e => {
                console.log('WebRTC event received:', e.data);
                
                if (e.data.includes("EVENT_TYPE_SWITCH_TO_SPEAKING")) {
                    isSpeaking = true;
                    document.getElementById('stopAvatarButton').disabled = false;
                } else if (e.data.includes("EVENT_TYPE_SWITCH_TO_IDLE")) {
                    isSpeaking = false;
                    document.getElementById('stopAvatarButton').disabled = true;
                }
            };
        });

        // Create a data channel (workaround to make sure the data channel listening is working)
        peerConnection.createDataChannel("eventChannel");

        // Update UI when connection state changes
        peerConnection.oniceconnectionstatechange = e => {
            console.log("WebRTC connection state:", peerConnection.iceConnectionState);
            if (peerConnection.iceConnectionState === 'disconnected' || 
                peerConnection.iceConnectionState === 'failed') {
                sessionActive = false;
                document.getElementById('startAvatarButton').disabled = false;
                document.getElementById('stopAvatarButton').disabled = true;
            }
        };

        // Add transceivers for audio and video
        peerConnection.addTransceiver('video', { direction: 'sendrecv' });
        peerConnection.addTransceiver('audio', { direction: 'sendrecv' });

        // Create offer and set local description
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);

        // Wait for ICE gathering to complete
        let iceGatheringComplete = false;
        const iceGatheringCompletePromise = new Promise(resolve => {
            setTimeout(() => {
                if (!iceGatheringComplete) {
                    iceGatheringComplete = true;
                    resolve();
                }
            }, 2000);
            
            peerConnection.onicecandidate = e => {
                if (!e.candidate && !iceGatheringComplete) {
                    iceGatheringComplete = true;
                    resolve();
                }
            };
        });

        await iceGatheringCompletePromise;

        // Connect to avatar service with local SDP
        const localSdp = btoa(JSON.stringify(peerConnection.localDescription));
        
        // Log SDP for debugging
        console.log("Local SDP (first 100 chars):", localSdp.substring(0, 100) + "...");
        
        // Connect to avatar service
        try {
            const connectResponse = await fetch('/api/connectAvatar', {
                method: 'POST',
                headers: {
                    'X-CSRFToken': csrfToken,
                    'AvatarCharacter': avatarCharacter,
                    'AvatarStyle': avatarStyle,
                    'TtsVoice': ttsVoice,
                    'CustomVoiceEndpointId': customVoiceEndpointId,
                    'PersonalVoiceSpeakerProfileId': personalVoiceSpeakerProfileID,
                    'IsCustomAvatar': isCustom.toString()
                },
                body: localSdp
            });

            // Detailed error handling
            if (!connectResponse.ok) {
                const errorText = await connectResponse.text();
                console.error('Avatar connection error response:', errorText);
                console.error('Response status:', connectResponse.status);
                console.error('Response headers:', Object.fromEntries([...connectResponse.headers]));
                throw new Error(`Failed to connect to avatar service: ${connectResponse.status}. Server response: ${errorText}`);
            }

            console.log("Avatar connection successful, parsing response...");
            // Get remote SDP and set it
            const remoteSdpText = await connectResponse.text();
            console.log("Remote SDP response (first 100 chars):", remoteSdpText.substring(0, 100) + "...");
            
            try {
                const parsedRemoteSdp = JSON.parse(atob(remoteSdpText));
                console.log("Remote SDP parsed successfully");
                await peerConnection.setRemoteDescription(new RTCSessionDescription(parsedRemoteSdp));
                console.log('Avatar service connected successfully');
                return true;
            } catch (e) {
                console.error('Failed to parse remote SDP:', e);
                console.error('Raw remote SDP text:', remoteSdpText);
                throw new Error(`Invalid remote SDP format: ${e.message}`);
            }
        } catch (fetchError) {
            console.error('Fetch error details:', fetchError);
            throw fetchError;
        }
    } catch (error) {
        console.error('Error connecting to avatar service:', error);
        document.getElementById('startAvatarButton').disabled = false;
        sessionActive = false;
        return false;
    }
}

// Disconnect from avatar service
async function disconnectAvatarService() {
    try {
        // Get CSRF token
        const csrfToken = document.querySelector('meta[name="csrf-token"]').getAttribute('content');
        
        // Disconnect from avatar service
        await fetch('/api/disconnectAvatar', {
            method: 'POST',
            headers: {
                'X-CSRFToken': csrfToken
            }
        });
        
        // Close peer connection
        if (peerConnection) {
            peerConnection.close();
            peerConnection = null;
        }
        
        // Reset video element
        const videoElement = document.getElementById('avatarVideo');
        if (videoElement.srcObject) {
            videoElement.srcObject.getTracks().forEach(track => track.stop());
            videoElement.srcObject = null;
        }
        
        // Reset audio element
        const audioElement = document.getElementById('avatarAudio');
        if (audioElement && audioElement.srcObject) {
            audioElement.srcObject.getTracks().forEach(track => track.stop());
            audioElement.srcObject = null;
        }
        
        sessionActive = false;
        document.getElementById('startAvatarButton').disabled = false;
        document.getElementById('stopAvatarButton').disabled = true;
        
        console.log('Avatar service disconnected successfully');
        return true;
        
    } catch (error) {
        console.error('Error disconnecting from avatar service:', error);
        return false;
    }
}

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

    // Avatar buttons
    document.getElementById('startAvatarButton').addEventListener('click', async function() {
        this.disabled = true;
        await connectAvatarService();
    });
    
    document.getElementById('stopAvatarButton').addEventListener('click', async function() {
        this.disabled = true;
        await disconnectAvatarService();
    });
    
    // Microphone buttons
    document.getElementById('startMicButton').addEventListener('click', function() {
        var avatar = document.getElementById('avatarVideo');
        if (avatar && avatar.style.display !== 'none' && avatar.style.display !== '') {
            startAvatarConversation();
        } else {
            startModelConversation();
        }
    });
    
    document.getElementById('stopMicButton').addEventListener('click', function() {
        stopRecognition();
    });
    
    // Chat form submission
    document.querySelector('.message-form').addEventListener('submit', function(e) {
        e.preventDefault();
        const messageInput = document.getElementById('messageInput');
        const message = messageInput.value.trim();
        if (message) {
            handleChatMessage(message);
            messageInput.value = '';
        }
    });
    
    // Initialize with disabled mic button until speech SDK is ready
    document.getElementById('startMicButton').disabled = true;
    
    // Initialize speech config when page loads
    initializeSpeechConfig().then(() => {
        document.getElementById('startMicButton').disabled = false;
    });
});
