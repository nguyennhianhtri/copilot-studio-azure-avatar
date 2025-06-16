from flask import Flask, render_template, request, jsonify, session, Response
from flask_wtf.csrf import CSRFProtect
import requests
import os
from dotenv import load_dotenv
import uuid
import logging
from datetime import datetime
import time
import threading
import json
import azure.cognitiveservices.speech as speechsdk
import traceback
from pathlib import Path

# Configure logging
logging.basicConfig(level=logging.DEBUG)
logger = logging.getLogger(__name__)

# Load environment variables
env_path = Path('.') / '.env'
load_dotenv(env_path)

# Validate required environment variables
required_vars = ['DIRECT_LINE_SECRET', 'SPEECH_REGION', 'SPEECH_KEY']
missing_vars = [var for var in required_vars if not os.getenv(var)]
if missing_vars:
    logger.error(f"Missing required environment variables: {', '.join(missing_vars)}")

app = Flask(__name__)
app.config['SECRET_KEY'] = os.getenv('SECRET_KEY', 'your-development-secret-key-here')  # Fallback for development
csrf = CSRFProtect(app)

# Speech token management
speech_token = None
speech_region = os.getenv('SPEECH_REGION')
speech_key = os.getenv('SPEECH_KEY')
ice_token = None  # Global ICE token that gets refreshed automatically

def refresh_speech_token():
    """Refresh the speech token every 9 minutes."""
    global speech_token
    while True:
        try:
            response = requests.post(
                f'https://{speech_region}.api.cognitive.microsoft.com/sts/v1.0/issueToken',
                headers={'Ocp-Apim-Subscription-Key': speech_key}
            )
            if response.status_code == 200:
                speech_token = response.text
                logger.debug("Speech token refreshed successfully")
            else:
                logger.error(f"Failed to refresh speech token: {response.status_code} {response.text}")
        except Exception as e:
            logger.error(f"Error refreshing speech token: {str(e)}")
        time.sleep(540)  # Sleep for 9 minutes

def refresh_ice_token():
    """Refresh the ICE token every 24 hours."""
    global ice_token
    while True:
        try:
            # Check if speech key and region are set
            if not speech_key or not speech_region:
                logger.error("Speech key or region not set, cannot refresh ICE token")
                time.sleep(60)  # Wait a minute before retrying
                continue
                
            logger.debug("Attempting to refresh ICE token")
            response = requests.get(
                f'https://{speech_region}.tts.speech.microsoft.com/cognitiveservices/avatar/relay/token/v1',
                headers={'Ocp-Apim-Subscription-Key': speech_key}
            )
            
            if response.status_code == 200:
                ice_token = response.text
                logger.debug("ICE token refreshed successfully")
                # Verify the token is valid JSON
                try:
                    json.loads(ice_token)
                    logger.debug("ICE token is valid JSON")
                except json.JSONDecodeError as e:
                    logger.error(f"Invalid ICE token format: {str(e)}")
                    logger.error(f"Raw token: {ice_token[:100]}...")
                    ice_token = None
            else:
                logger.error(f"Failed to refresh ICE token: {response.status_code} {response.text}")
                ice_token = None
                
        except Exception as e:
            logger.error(f"Error refreshing ICE token: {str(e)}")
            logger.error(f"Traceback: {traceback.format_exc()}")
            ice_token = None
            
        # If this is the first run and we got a token, break the loop
        if ice_token:
            break
            
        time.sleep(60)  # Wait a minute before retrying

# Start the speech token refresh thread
speech_token_thread = threading.Thread(target=refresh_speech_token)
speech_token_thread.daemon = True
speech_token_thread.start()

# Start the ICE token refresh thread
ice_token_thread = threading.Thread(target=refresh_ice_token)
ice_token_thread.daemon = True
ice_token_thread.start()

# DirectLine API Configuration
DIRECTLINE_URL = "https://directline.botframework.com/v3/directline"

def generate_directline_token():
    """Generate a DirectLine token for the conversation."""
    headers = {
        'Authorization': f'Bearer {os.getenv("DIRECT_LINE_SECRET")}'
    }
    
    try:
        logger.debug("Attempting to generate DirectLine token")
        response = requests.post(f"{DIRECTLINE_URL}/tokens/generate", headers=headers)
        logger.debug(f"Token generation response status: {response.status_code}")
        logger.debug(f"Token response content: {response.text}")
        
        if response.status_code == 200:
            data = response.json()
            return {
                'token': data['token'],
                'expires_in': data.get('expires_in', 3600)
            }
        else:
            logger.error(f"Failed to generate token. Status: {response.status_code}, Response: {response.text}")
            return None
            
    except Exception as e:
        logger.error(f"Error generating token: {str(e)}")
        return None

def start_conversation():
    """Start a new conversation with the bot."""
    # First, generate a DirectLine token
    token_data = generate_directline_token()
    if not token_data:
        logger.error("Failed to generate DirectLine token. Check if DIRECT_LINE_SECRET is valid.")
        return None
        
    headers = {
        'Authorization': f'Bearer {token_data["token"]}'
    }
    
    try:
        response = requests.post(f"{DIRECTLINE_URL}/conversations", headers=headers)
        logger.debug(f"Start conversation response status: {response.status_code}")
        logger.debug(f"Response content: {response.text}")
        
        if response.status_code == 201:
            data = response.json()
            conversation_id = data.get('conversationId')
            if not conversation_id:
                logger.error("No conversation ID in response")
                return None
            return {
                'conversation_id': conversation_id,
                'token': token_data['token'],
                'expires_in': token_data['expires_in']
            }
        else:
            logger.error(f"Failed to start conversation: {response.text}")
            return None
            
    except Exception as e:
        logger.error(f"Error starting conversation: {str(e)}")
        return None

def send_message(conversation_id, message, token):
    """Send a message to the bot and return the message ID."""
    if not conversation_id or not token:
        logger.error("Missing conversation ID or token")
        return None

    headers = {
        'Authorization': f'Bearer {token}',
        'Content-Type': 'application/json'
    }
    
    payload = {
        'type': 'message',
        'from': {
            'id': 'user',
            'name': 'Web User'
        },
        'text': message
    }
    
    try:
        url = f"{DIRECTLINE_URL}/conversations/{conversation_id}/activities"
        logger.debug(f"Sending message to URL: {url}")
        logger.debug(f"Message payload: {payload}")
        
        response = requests.post(url, headers=headers, json=payload)
        logger.debug(f"Send message response status: {response.status_code}")
        logger.debug(f"Response content: {response.text}")
        
        if response.status_code == 200 or response.status_code == 201:
            data = response.json()
            return data.get('id')  # Return the message ID
        return None
    except Exception as e:
        logger.error(f"Error sending message: {str(e)}")
        return None

def log_all_activities(activities, user_message_id):
    """Debug function to log all activities and help understand the new response format"""
    logger.debug(f"=== All Activities for message {user_message_id} ===")
    for i, activity in enumerate(activities):
        logger.debug(f"Activity {i}: type={activity.get('type')}, "
                    f"from_role={activity.get('from', {}).get('role')}, "
                    f"from_name={activity.get('from', {}).get('name')}, "
                    f"replyToId={activity.get('replyToId')}, "
                    f"text={activity.get('text', 'N/A')[:50]}..., "
                    f"valueType={activity.get('valueType')}")
    logger.debug("=== End Activities ===")

def get_bot_response(conversation_id, token, user_message_id):
    """Get bot's response for a specific user message."""
    if not conversation_id or not token:
        logger.error("Missing conversation ID or token")
        return None

    headers = {
        'Authorization': f'Bearer {token}'
    }
    
    try:
        url = f"{DIRECTLINE_URL}/conversations/{conversation_id}/activities"
        logger.debug(f"Getting response from URL: {url}")
        response = requests.get(url, headers=headers)
        logger.debug(f"Get response status: {response.status_code}")
        
        if response.status_code == 200:
            data = response.json()
            activities = data.get('activities', [])
            logger.debug(f"Found {len(activities)} total activities")
            
            # Log all activities for debugging
            log_all_activities(activities, user_message_id)

            # Find the user's message
            user_message = next(
                (activity for activity in activities if activity.get('id') == user_message_id),
                None
            )
            
            if not user_message:
                logger.error(f"Could not find user message with ID: {user_message_id}")
                return None
                
            # Find the bot's response that replies to this message
            # First check for traditional text messages, then for event messages
            bot_response = next(
                (activity for activity in activities 
                 if activity.get('replyToId') == user_message_id and
                 activity.get('from', {}).get('role') == 'bot' and
                 activity.get('type') == 'message' and
                 activity.get('text')),  # Only get messages with actual text
                None
            )
            
            # If no text message found, check for other bot activities that might contain content
            if not bot_response:
                # Look for any bot activity that replies to our message
                bot_activities = [
                    activity for activity in activities 
                    if activity.get('replyToId') == user_message_id and
                    activity.get('from', {}).get('role') == 'bot'
                ]
                
                # Log all bot activities for debugging
                for activity in bot_activities:
                    logger.debug(f"Bot activity found: type={activity.get('type')}, text={activity.get('text', 'N/A')}, valueType={activity.get('valueType', 'N/A')}")
                
                # Try to find a message with text content
                bot_response = next(
                    (activity for activity in bot_activities 
                     if activity.get('type') == 'message' and activity.get('text')),
                    None
                )
                
                # If still no response, wait longer for plan execution to complete
                if not bot_response:
                    logger.debug("No immediate bot response found, waiting for plan execution...")
                    time.sleep(5)  # Wait longer for new plan-based responses
                    
                    # Try again with fresh data
                    response = requests.get(url, headers=headers)
                    if response.status_code == 200:
                        data = response.json()
                        activities = data.get('activities', [])
                        logger.debug(f"After waiting, found {len(activities)} total activities")
                        
                        # Look for bot responses again
                        bot_response = next(
                            (activity for activity in activities 
                             if activity.get('replyToId') == user_message_id and
                             activity.get('from', {}).get('role') == 'bot' and
                             activity.get('type') == 'message' and
                             activity.get('text')),
                            None
                        )
            
            if bot_response:
                logger.debug(f"Found bot response: {bot_response}")
                response_text = bot_response.get('text', 'No response')
                if not response_text or response_text.strip() == '':
                    response_text = 'I received your message but have no text response.'
                return {
                    'text': response_text,
                    'watermark': str(len(activities))
                }
            else:
                logger.debug("No bot response found for this message")
                # If still no response found, wait a bit and try one final time
                time.sleep(3)
                response = requests.get(url, headers=headers)
                if response.status_code == 200:
                    data = response.json()
                    activities = data.get('activities', [])
                    logger.debug(f"Final attempt: found {len(activities)} total activities")
                    
                    bot_response = next(
                        (activity for activity in activities 
                         if activity.get('replyToId') == user_message_id and
                         activity.get('from', {}).get('role') == 'bot' and
                         activity.get('type') == 'message'),
                        None
                    )
                    if bot_response:
                        response_text = bot_response.get('text', 'Response received without text content')
                        return {
                            'text': response_text,
                            'watermark': str(len(activities))
                        }
                        
                # As a last resort, return a default response indicating the bot processed the message
                logger.warning("Bot activity detected but no text response found")
                return {
                    'text': 'I received your message and am processing it, but no text response was generated.',
                    'watermark': str(len(activities) if 'activities' in locals() else session.get('watermark', '0'))
                }
                
        logger.error(f"Failed to get bot response: {response.text}")
        return None
    except Exception as e:
        logger.error(f"Error getting bot response: {str(e)}")
        return None

@app.route('/')
def home():
    # Generate client ID if not in session
    if 'client_id' not in session:
        session['client_id'] = f"client_{uuid.uuid4()}"
        logger.debug(f"Generated new client ID: {session['client_id']}")
    
    # Check if required environment variables are set
    required_vars = ['DIRECT_LINE_SECRET', 'SPEECH_REGION', 'SPEECH_KEY']
    missing_vars = [var for var in required_vars if not os.getenv(var)]
    
    if missing_vars:
        logger.error(f"Missing required environment variables: {', '.join(missing_vars)}")
        # Pass speech configuration to template (empty values since they're missing)
        template_vars = {
            'SPEECH_REGION': '',
            'SPEECH_KEY': ''
        }
        return render_template('index.html', **template_vars)

    # Only start a new conversation if all required variables are present
    if 'conversation' not in session:
        conversation = start_conversation()
        if conversation:
            session['conversation'] = conversation
            session['watermark'] = '0'
            logger.debug(f"Started new conversation: {conversation}")
        else:
            return "Failed to start conversation with bot", 500

    # Pass speech configuration to template
    template_vars = {
        'SPEECH_REGION': os.getenv('SPEECH_REGION', ''),
        'SPEECH_KEY': os.getenv('SPEECH_KEY', '')
    }
    
    logger.debug(f"Speech configuration: Region={template_vars['SPEECH_REGION'][:5]}..., Key={template_vars['SPEECH_KEY'][:5]}...")
    
    return render_template('index.html', **template_vars)

@app.route('/chat', methods=['POST'])
def chat():
    message = request.json.get('message')
    if not message:
        return jsonify({'error': 'No message provided'}), 400
        
    logger.debug(f"Received message: {message}")
    logger.debug(f"Session state: {dict(session)}")
    
    # Get conversation details from session
    conversation = session.get('conversation')
    logger.debug(f"Conversation details: {conversation}")
    
    if not conversation:
        logger.debug("No conversation found in session, starting new one")
        # Try to start a new conversation
        conversation = start_conversation()
        if not conversation:
            logger.error("Failed to start new conversation")
            return jsonify({'error': 'Failed to start conversation'}), 500
        session['conversation'] = conversation
        session['watermark'] = '0'
    
    conversation_id = conversation.get('conversation_id')
    token = conversation.get('token')
    
    if not conversation_id or not token:
        logger.error("Invalid conversation state")
        return jsonify({'error': 'Invalid conversation state'}), 500
    
    # Send message to bot and get message ID
    message_id = send_message(conversation_id, message, token)
    if not message_id:
        # If message sending fails, try to refresh the token and retry
        logger.debug("Message sending failed, attempting to refresh token")
        new_conversation = start_conversation()
        if new_conversation:
            session['conversation'] = new_conversation
            conversation_id = new_conversation['conversation_id']
            token = new_conversation['token']
            message_id = send_message(conversation_id, message, token)
            if not message_id:
                return jsonify({'error': 'Failed to send message after token refresh'}), 500
        else:
            return jsonify({'error': 'Failed to refresh token'}), 500
    
    # Get bot's response with retries
    max_retries = 5
    retry_count = 0
    
    while retry_count < max_retries:
        response = get_bot_response(conversation_id, token, message_id)
        if response:
            session['watermark'] = response['watermark']
            return jsonify({'response': response['text']})
        retry_count += 1
        time.sleep(2)  # Wait longer between retries
    
    return jsonify({'error': 'No response from bot after retries'}), 500

@app.route("/api/getSpeechToken", methods=["GET"])
@csrf.exempt  # Exempt this endpoint from CSRF protection
def get_speech_token():
    """Return the speech token and region"""
    global speech_token
    if not speech_token:
        refresh_speech_token()  # Make sure we have a token
    
    response = Response(speech_token, status=200)
    response.headers['SpeechRegion'] = os.getenv('SPEECH_REGION')
    return response

@app.route("/api/getIceToken", methods=["GET"])
@csrf.exempt  # Exempt this endpoint from CSRF protection
def get_ice_token():
    """Return the ICE token for WebRTC connection"""
    global ice_token
    try:
        # Check if speech key and region are set
        if not speech_key or not speech_region:
            logger.error("Speech key or region not set")
            return Response("Speech key or region not configured", status=500)
            
        # Wait for the token to be available
        retry_count = 0
        while ice_token is None and retry_count < 5:
            logger.debug(f"Waiting for ICE token, attempt {retry_count + 1}")
            time.sleep(0.5)
            retry_count += 1
            
        if ice_token is None:
            logger.error("ICE token not available after retries")
            # Try to refresh the token immediately
            try:
                response = requests.get(
                    f'https://{speech_region}.tts.speech.microsoft.com/cognitiveservices/avatar/relay/token/v1',
                    headers={'Ocp-Apim-Subscription-Key': speech_key}
                )
                if response.status_code == 200:
                    ice_token = response.text
                    logger.debug("ICE token refreshed successfully")
                else:
                    logger.error(f"Failed to refresh ICE token: {response.status_code} {response.text}")
                    return Response(f"Failed to get ICE token: {response.text}", status=response.status_code)
            except Exception as e:
                logger.error(f"Error refreshing ICE token: {str(e)}")
                return Response(f"Error getting ICE token: {str(e)}", status=500)
        
        try:
            # Return the global ICE token
            ice_token_obj = json.loads(ice_token)
            return jsonify(ice_token_obj)
        except json.JSONDecodeError as e:
            logger.error(f"Error parsing ICE token: {str(e)}")
            logger.error(f"Raw ICE token: {ice_token[:100]}...")
            return Response("Invalid ICE token format", status=500)
            
    except Exception as e:
        logger.error(f"Unexpected error in get_ice_token: {str(e)}")
        logger.error(f"Traceback: {traceback.format_exc()}")
        return Response(f"Unexpected error: {str(e)}", status=500)

# Global dictionaries to store speech synthesizers and connections
avatar_connections = {}
speech_synthesizers = {}

# The API route to connect to the avatar service
@app.route("/api/connectAvatar", methods=["POST"])
@csrf.exempt  # Exempt this endpoint from CSRF protection
def connect_avatar():
    """Connect to the avatar service"""
    global ice_token, avatar_connections, speech_synthesizers
    try:
        # Log raw request data for debugging
        logger.debug(f"Request Content-Type: {request.headers.get('Content-Type')}")
        logger.debug(f"Request body type: {type(request.data)}")
        request_data = request.data.decode('utf-8') if request.data else ""
        logger.debug(f"Request body content (first 100 chars): {request_data[:100]}")
        
        # Get the local SDP from request body
        local_sdp = request_data
        
        # Log ICE token for debugging
        logger.debug(f"Current ICE token status: {'Available' if ice_token else 'None'}")
        if ice_token:
            logger.debug(f"ICE token content (first 50 chars): {ice_token[:50]}")
        
        # Get avatar params from headers
        client_id = request.headers.get('ClientId', session.get('client_id', 'default_client'))
        voice_name = request.headers.get('TtsVoice', "en-US-JennyNeural")
        style = request.headers.get('AvatarStyle', "casual-sitting")
        avatar_character = request.headers.get('AvatarCharacter', 'lisa')
        is_custom = request.headers.get('IsCustomAvatar', 'false').lower() == 'true'
        logger.debug(f"Avatar params - ClientId: {client_id}, Voice: {voice_name}, Style: {style}, Character: {avatar_character}, IsCustom: {is_custom}")
        
        connection_id = client_id  # Use client_id as the connection identifier
        
        # Wait for the global ice_token to be available if needed
        retry_count = 0
        while ice_token is None and retry_count < 5:
            logger.debug(f"Waiting for ICE token, retry {retry_count+1}")
            time.sleep(0.5)
            retry_count += 1
            
        if ice_token is None:
            logger.error("ICE token not available after retries")
            return Response("Failed to connect: ICE token not available", status=500)
            
        try:
            logger.debug("Attempting to parse ICE token as JSON")
            ice_token_obj = json.loads(ice_token)
            logger.debug(f"ICE token parsed successfully with keys: {list(ice_token_obj.keys())}")
        except Exception as e:
            logger.error(f"Error parsing ICE token: {str(e)}")
            logger.error(f"Raw ICE token (first 100 chars): {ice_token[:100]}")
            return Response(f"Error parsing ICE token: {str(e)}", status=500)
        
        # Using a global Speech Config ensures we reuse the connection
        logger.debug(f"Creating speech config with region: {speech_region}")
        speech_config = speechsdk.SpeechConfig(
            subscription=speech_key, 
            endpoint=f'wss://{speech_region}.tts.speech.microsoft.com/cognitiveservices/websocket/v1?enableTalkingAvatar=true'
        )
        speech_config.speech_synthesis_voice_name = voice_name
        
        # Create speech synthesizer
        logger.debug("Creating speech synthesizer")
        speech_synthesizer = speechsdk.SpeechSynthesizer(speech_config=speech_config, audio_config=None)
        
        # Set up connection to avatar service
        logger.debug("Setting up connection to avatar service")
        connection = speechsdk.Connection.from_speech_synthesizer(speech_synthesizer)
        
        # Create avatar config with WebRTC settings
        logger.debug("Creating avatar config")
        avatar_config = {
            'synthesis': {
                'video': {
                    'protocol': {
                        'name': "WebRTC",
                        'webrtcConfig': {
                            'clientDescription': local_sdp,
                            'iceServers': [{
                                'urls': [ ice_token_obj['Urls'][0] ],
                                'username': ice_token_obj['Username'],
                                'credential': ice_token_obj['Password']
                            }]
                        },
                    },
                    'format': {
                        'bitrate': 1000000
                    },
                    'talkingAvatar': {
                        'customized': is_custom,
                        'character': avatar_character,
                        'style': style,
                        'background': {
                            'color': '#FFFFFFFF'
                        }
                    }
                }
            }
        }
        
        # Set the avatar configuration
        logger.debug("Setting avatar configuration")
        connection.set_message_property('speech.config', 'context', json.dumps(avatar_config))
        
        # Store connection and synthesizer in dictionaries using client_id
        avatar_connections[client_id] = connection
        speech_synthesizers[client_id] = speech_synthesizer
        
        # Initialize the connection with an empty speak
        logger.debug("Initializing the connection with an empty speak")
        result = speech_synthesizer.speak_text_async('').get()
        logger.debug(f"Initial speak result reason: {result.reason}")
        
        if result.reason == speechsdk.ResultReason.Canceled:
            cancellation_details = result.cancellation_details
            logger.error(f"Speech synthesis canceled: {cancellation_details.reason}")
            logger.error(f"Error details: {cancellation_details.error_details}")
            return Response(f"Error connecting to avatar: {cancellation_details.error_details}", status=400)
        
        # Get the remote SDP for WebRTC
        logger.debug("Getting remote SDP for WebRTC")
        try:
            # The key name might be different between SDK versions, try both possible names
            turn_start_message = None
            possible_keys = ['SpeechSDK-Synthesis-TurnStart', 'SpeechSDKInternal-ExtraTurnStartMessage']
            
            for key in possible_keys:
                try:
                    turn_start_message = speech_synthesizer.properties.get_property_by_name(key)
                    if turn_start_message:
                        logger.debug(f"Found turn start message using key: {key}")
                        break
                except Exception as key_error:
                    logger.debug(f"Key {key} not found: {str(key_error)}")
            
            if not turn_start_message:
                # List all available properties for debugging
                logger.error("Could not get turn start message, listing available properties:")
                prop_names = []
                for i in range(speech_synthesizer.properties.property_count):
                    try:
                        name = speech_synthesizer.properties.at(i)
                        value = speech_synthesizer.properties.get_property_by_name(name)
                        prop_names.append(f"{name}: {value[:20]}..." if isinstance(value, str) and len(value) > 20 else f"{name}: {value}")
                    except Exception as e:
                        prop_names.append(f"{i}: Error: {str(e)}")
                logger.error(f"Available properties: {', '.join(prop_names)}")
                return Response("Could not get remote SDP: turn start message not found", status=500)
                
            logger.debug(f"Turn start message received (first 100 chars): {turn_start_message[:100] if turn_start_message else 'None'}")
            
            # Try to parse the WebRTC connection string
            try:
                message_json = json.loads(turn_start_message)
                logger.debug(f"Message JSON keys: {list(message_json.keys())}")
                
                # Handle different formats based on SDK version
                if 'webrtc' in message_json:
                    remote_sdp = message_json['webrtc']['connectionString']
                elif 'WebRtc' in message_json:
                    remote_sdp = message_json['WebRtc']['connectionString']
                else:
                    # Try to find any key that might contain 'connection' or 'sdp'
                    candidates = []
                    def find_connection_key(obj, path=""):
                        if isinstance(obj, dict):
                            for k, v in obj.items():
                                if 'connect' in k.lower() or 'sdp' in k.lower() or 'string' in k.lower():
                                    candidates.append((f"{path}.{k}" if path else k, v))
                                find_connection_key(v, f"{path}.{k}" if path else k)
                        elif isinstance(obj, list):
                            for i, item in enumerate(obj):
                                find_connection_key(item, f"{path}[{i}]")
                    
                    find_connection_key(message_json)
                    if candidates:
                        logger.debug(f"Potential connection string candidates: {candidates}")
                        # Use the first candidate
                        remote_sdp = candidates[0][1]
                    else:
                        logger.error(f"Could not find connection string in message: {turn_start_message}")
                        return Response("Could not find WebRTC connection string in turn start message", status=500)
                
                logger.debug(f"Remote SDP parsed successfully (length: {len(remote_sdp)})")
            except KeyError as ke:
                logger.error(f"Key error parsing turn start message: {str(ke)}")
                logger.error(f"Turn start message: {turn_start_message}")
                return Response(f"Error getting remote SDP (key error): {str(ke)}", status=500)
                
        except Exception as e:
            logger.error(f"Error getting remote SDP: {str(e)}")
            logger.error(f"Turn start message: {turn_start_message if 'turn_start_message' in locals() else 'Not available'}")
            return Response(f"Error getting remote SDP: {str(e)}", status=500)
        
        # Connection is now tracked by client_id instead of session
        logger.debug(f"Avatar connection established for client ID: {client_id}")
        
        # Return the remote SDP
        logger.debug("Returning remote SDP to client")
        return Response(remote_sdp, status=200)
    except Exception as e:
        logger.error(f"Error connecting to avatar: {str(e)}")
        logger.error(f"Traceback: {traceback.format_exc()}")
        return Response(f"Error connecting to avatar: {str(e)}", status=500)

# The API route to speak through the avatar
@app.route("/api/speak", methods=["POST"])
@csrf.exempt  # Exempt this endpoint from CSRF protection
def speak():
    """Speak through the avatar"""
    try:
        # Get client ID from headers
        client_id = request.headers.get('ClientId', session.get('client_id', 'default_client'))
        
        # Get the speech synthesizer from the dictionary using client_id
        speech_synthesizer = speech_synthesizers.get(client_id)
        if not speech_synthesizer:
            logger.error(f"Speech synthesizer not found for client ID: {client_id}")
            return Response("Speech synthesizer not found", status=400)
        
        # Get the SSML to speak
        ssml = request.data.decode('utf-8')
        logger.debug(f"Speaking SSML for client {client_id}: {ssml[:100]}...")
        
        # Speak the SSML
        result = speech_synthesizer.speak_ssml_async(ssml).get()
        
        if result.reason == speechsdk.ResultReason.Canceled:
            cancellation_details = result.cancellation_details
            logger.error(f"Speech synthesis canceled for client {client_id}: {cancellation_details.error_details}")
            return Response(f"Error speaking: {cancellation_details.error_details}", status=400)
        
        logger.debug(f"Speech successful for client {client_id}, result ID: {result.result_id}")
        return Response(result.result_id, status=200)
        
    except Exception as e:
        logger.error(f"Error speaking: {str(e)}")
        return Response(f"Error speaking: {str(e)}", status=500)

# The API route to stop speaking
@app.route("/api/stopSpeaking", methods=["POST"])
@csrf.exempt  # Exempt this endpoint from CSRF protection
def stop_speaking():
    """Stop the avatar from speaking"""
    try:
        # Get client ID from headers
        client_id = request.headers.get('ClientId', session.get('client_id', 'default_client'))
        
        # Get the connection from the dictionary using client_id
        connection = avatar_connections.get(client_id)
        if not connection:
            logger.error(f"Avatar connection not found for client ID: {client_id}")
            return Response("Avatar connection not found", status=400)
        
        # Send stop message
        logger.debug(f"Stopping speech for client {client_id}")
        connection.send_message_async('synthesis.control', '{"action":"stop"}').get()
        
        logger.debug(f"Speech stopped successfully for client {client_id}")
        return Response("Speaking stopped", status=200)
        
    except Exception as e:
        logger.error(f"Error stopping speech: {str(e)}")
        return Response(f"Error stopping speech: {str(e)}", status=500)

# The API route to disconnect from the avatar service
@app.route("/api/disconnectAvatar", methods=["POST"])
@csrf.exempt  # Exempt this endpoint from CSRF protection
def disconnect_avatar():
    """Disconnect from the avatar service"""
    try:
        # Get client ID from headers
        client_id = request.headers.get('ClientId', session.get('client_id', 'default_client'))
        
        # Get the connection from the dictionary using client_id
        connection = avatar_connections.get(client_id)
        if connection:
            logger.debug(f"Closing avatar connection for client {client_id}")
            connection.close()
            
        # Remove the connection and synthesizer from dictionaries
        if client_id in avatar_connections:
            del avatar_connections[client_id]
            logger.debug(f"Removed avatar connection for client {client_id}")
        if client_id in speech_synthesizers:
            del speech_synthesizers[client_id]
            logger.debug(f"Removed speech synthesizer for client {client_id}")
        
        logger.debug(f"Avatar disconnected successfully for client {client_id}")
        return Response("Disconnected", status=200)
        
        return Response("Avatar disconnected", status=200)
        
    except Exception as e:
        logger.error(f"Error disconnecting avatar: {str(e)}")
        return Response(f"Error disconnecting avatar: {str(e)}", status=500)

# Create a memory log handler for the debug endpoint
log_buffer = []

class BufferHandler(logging.Handler):
    def emit(self, record):
        log_buffer.append(self.format(record))
        if len(log_buffer) > 1000:  # Limit to 1000 entries
            log_buffer.pop(0)

# Add the buffer handler to the logger
buffer_handler = BufferHandler()
buffer_handler.setFormatter(logging.Formatter('%(asctime)s - %(levelname)s - %(message)s'))
logger.addHandler(buffer_handler)

# Debug endpoint to view logs
@app.route("/debug/logs")
def view_logs():
    """View the server logs through the browser"""
    return Response("<pre>" + "\n".join(log_buffer) + "</pre>", 
                   status=200, 
                   mimetype="text/html")

# Debug endpoint to view the ICE token
@app.route("/debug/ice-token")
def view_ice_token():
    """View the current ICE token status for debugging"""
    global ice_token
    try:
        if ice_token:
            token_obj = json.loads(ice_token) 
            return jsonify({
                "token_available": True,
                "token_keys": list(token_obj.keys()),
                "token_sample": ice_token[:100] + "..." if len(ice_token) > 100 else ice_token
            })
        else:
            return jsonify({
                "token_available": False,
                "message": "ICE token is not available yet"
            })
    except Exception as e:
        return jsonify({
            "token_available": True,
            "error": str(e),
            "raw_token": ice_token[:200] + "..." if ice_token and len(ice_token) > 200 else ice_token
        })

@app.route('/api/check-env', methods=['GET'])
def check_env():
    """Check if .env file exists and has required variables"""
    env_exists = env_path.exists()
    required_vars = ['DIRECT_LINE_SECRET', 'SPEECH_KEY', 'SPEECH_REGION']
    missing_vars = [var for var in required_vars if not os.getenv(var)]
    
    # Get existing values if they exist
    existing_values = {
        'directLineSecret': os.getenv('DIRECT_LINE_SECRET', ''),
        'secretKey': os.getenv('SECRET_KEY', ''),
        'speechKey': os.getenv('SPEECH_KEY', ''),
        'speechRegion': os.getenv('SPEECH_REGION', '')
    }
    
    return jsonify({
        'exists': env_exists and not missing_vars,
        'missing_vars': missing_vars,
        'values': existing_values
    })

@app.route('/api/save-env', methods=['POST'])
def save_env():
    """Save environment variables to .env file"""
    try:
        data = request.get_json()
        required_vars = ['directLineSecret', 'secretKey', 'speechKey', 'speechRegion']
        
        # Validate required fields
        if not all(var in data for var in required_vars):
            return jsonify({
                'success': False,
                'message': 'Missing required fields'
            }), 400
            
        # Create .env content
        env_content = f"""# DirectLine Secret from Copilot Studio
DIRECT_LINE_SECRET={data['directLineSecret']}

# Flask Secret Key
SECRET_KEY={data['secretKey']}

# Azure Speech Service Configuration
SPEECH_REGION={data['speechRegion']}
SPEECH_KEY={data['speechKey']}"""
        
        # Write to .env file
        with open('.env', 'w') as f:
            f.write(env_content)
            
        # Reload environment variables
        load_dotenv(env_path, override=True)
        
        # Update global variables
        global speech_region, speech_key
        speech_region = os.getenv('SPEECH_REGION')
        speech_key = os.getenv('SPEECH_KEY')
        
        # Restart the ICE token refresh thread
        global ice_token_thread
        if ice_token_thread and ice_token_thread.is_alive():
            ice_token_thread.join(timeout=1)  # Wait for the thread to finish
        
        # Start a new ICE token refresh thread
        ice_token_thread = threading.Thread(target=refresh_ice_token)
        ice_token_thread.daemon = True
        ice_token_thread.start()
        
        # Wait a moment for the ICE token to be generated
        time.sleep(2)
        
        return jsonify({
            'success': True,
            'message': 'Environment variables saved successfully'
        })
        
    except Exception as e:
        logger.error(f"Error saving environment variables: {str(e)}")
        logger.error(f"Traceback: {traceback.format_exc()}")
        return jsonify({
            'success': False,
            'message': str(e)
        }), 500

if __name__ == '__main__':
    app.run(debug=True)