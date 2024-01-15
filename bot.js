const { ActivityType, Client, GatewayIntentBits, Interaction, Constants } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, VoiceReceiver, EndBehaviorType, getVoiceConnection } = require('@discordjs/voice');
const { OpusDecoder } = require('@discordjs/opus');
const { spawn } = require('child_process');
const prism = require('prism-media');
let ffmpegProcess; // global variable for ffmpeg process spawning
let currentUserID; // global variable to track the current user
const LUFS_THRESHOLD = -5; // adjust based on level needed
const SAMPLE_RATE = 48000;
const CHANNELS = 2;

const exceptionRoleIds = [
    '723328938188996678', // Owner
    '706878077745234001', // Admin IT/2
    '699757265095491654', // Admin IT
    '699755262575247390', // Discord Mod Permissions
    '699755315444318278', // Subreddit Mod
    '849500907757895680', // Submod Trial
    '729533526952640582', // Mod
    '699755999304876064', // Verified Conservative
    '706712719616638989', // Server Booster
    '838262316751126570', // Deputy T2
    '887026634295750698', // Deputy T1
    '926305880486588426', // VC Deputy
    '699755959890739201', // Verified
    '706550189862944860', // Level 60
    '706549930935844896', // Level 50
    '706549853005676575', // Level 40
    '705001657154404393', // Level 30
    '705001605581242410', // Level 20
    '705001499004239932', // Level 10
    '706542679873552435', // Level 7
    '705001314202943568', // Level 5
    '971516788766560377'  // Level 3
]

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.MessageContent,
        // Add any other intents you need
    ]
});

client.once('ready', () => {
    console.log('Bot is ready!');
		client.user.setPresence({ 
	      activities: [{ 
            type: ActivityType.Listening,
						name: 'your volume lvls'
	      }], 
        status: 'dnd' 
    });
});

function startFFmpegProcess() {
	  console.log('Starting FFmpeg Process');
	  // The FFmpeg command to calculate LUFS
    // This command reads audio from stdin, analyzes it, and outputs LUFS values
    const args = [
		    '-loglevel', 'debug',         // Verbose logging
        '-nostats', '-hide_banner',   // No stats, hide banner
        '-f', 's16le',                // Format (16-bit PCM)
        '-ar', '48k',                 // Sample rate
        '-ac', '2',                   // Channels
        '-i', 'pipe:0',               // Input from stdin
        '-filter_complex', 'ebur128', // LUFS filter
        '-f', 'null', '-'             // Output to nowhere
    ];
		console.log('Set ffmpeg args');
    ffmpegProcess = spawn('ffmpeg', args);
    console.log('Spawned ffmpeg');
		ffmpegProcess.stderr.on('data', (data) => {
				const output = data.toString();
				// Extract LUFS measurement from the output
				const lufsRegex = /M:\s*([\-\d\.]+)\s*S:\s*([\-\d\.]+)\s*I:\s*([\-\d\.]+)\s*LUFS\s*LRA:\s*([\-\d\.]+)/;
        const lufsMatch = output.match(lufsRegex);
        if (lufsMatch) {
            const momentaryLufs = parseFloat(lufsMatch[1]);  // M (momentary loudness) [400ms]
				    const shortTermLufs = parseFloat(lufsMatch[2]);  // S (short-term loudness) [1-3s]
				 // const loudnessRange = parseFloat(lufsMatch[4]);  // LRA (loudness range) [softest/loudest parts, dynamic range]
         // const integratedLufs = parseFloat(lufsMatch[3]); // I (integrated loudness) [extended period]
																														 // Integrated loudness cannot be used as this stays at a decreased
																														 // level for too long and will consistently meet the threshold
																														 // Loudness Range is effectively useless information (maybe)
            // Check if any of the LUFS values exceed the threshold
            if (momentaryLufs > LUFS_THRESHOLD || shortTermLufs > LUFS_THRESHOLD) {
                // Log LUFS values
                console.log(`High Loudness Detected | User: ${currentUserID} | Momentary LUFS: ${momentaryLufs}, Short-term LUFS: ${shortTermLufs}`);
            }
        }
		});
		ffmpegProcess.stdout.on('data', (data) => {
		    console.log(`FFmpeg Output: ${data.toString()}`);
		});
    ffmpegProcess.on('close', (code) => {
        console.log(`FFmpeg process exited with code ${code}`);
				ffmpegProcess = null; // reset 
    });
    return ffmpegProcess;
}

client.on('messageCreate', async message => {
    if (message.content === '!join') {
        console.log('Join command received');
        if (message.member.voice.channel) {
            console.log(`Attempting to join voice channel: ${message.member.voice.channel.id}`);
            try {
                // Start the FFmpeg Process
                startFFmpegProcess();
                const connection = joinVoiceChannel({
                    channelId: message.member.voice.channel.id,
                    guildId: message.guild.id,
                    adapterCreator: message.guild.voiceAdapterCreator,
                    selfDeaf: false,
                    selfMute: false,
                });
                const receiver = connection.receiver;
                receiver.speaking.on('start', (userId) => {
								    currentUserID = userId;
										member = message.guild.members.cache.get(currentUserID);
										const userName = member ? member.user.username : "Unknown User";
										if (!member) {
										    console.log(`Member with ID ${currentUserID} not found.`);
												return;
										}
										// Check if a user has any roles from the exception list
										const hasExceptionRole = member.roles.cache.get(role => exceptionRoleIds.includes(role.id));
										if (hasExceptionRole) {
										    console.log(`User ${userName} is in the exception list. Skipping audio processing.`);
												return;
										}
                    const audioStream = receiver.subscribe(userId, {
                        end: { behavior: EndBehaviorType.AfterSilence, duration: 100 },
                    });
                    // Create a new Opus to PCM decoder stream for each user
                    const decoder = new prism.opus.Decoder({ rate: SAMPLE_RATE, channels: CHANNELS, frameSize: 960 });
                    // Pipe the Opus audio stream into the decoder to convert to PCM
                    audioStream.pipe(decoder);
                    // Handle the PCM output from the decoder
                    decoder.on('data', (pcmData) => {
                        // Write PCM data to FFmpeg
                        if (ffmpegProcess && ffmpegProcess.stdin.writable) {
												    ffmpegProcess.stdin.write(pcmData, (err) => {
                            if (err) {
														    console.log(`Error writing to FFmpeg stdin: ${err}`);
														} else {
																/* Optional values (RMS and dB levels
																										sort of useless
						                            						LUFS is more accurate)
								    						*/
                    						// Process the PCM data
                    						const rms = calculateRMS(pcmData);
                    						const dBLevel = rmsToDecibels(rms);
                    						console.log(`User: ${userName} | (${userId}) | RMS value: ${rms}, dB level: ${dBLevel}`);
                              /*
                              Add in an if() call if the user meets the criteria for being too loud, kick/ban the user.
                              */
														}
												    });
												}
                    });
                    // Optional: Handle stream end or errors
                    decoder.on('end', () => {
                        console.log(`Decoding stream ended for user ${userId}`);
                    });
                    decoder.on('error', (err) => {
                        console.error(`Decoding error for user ${userId}:`, err);
                    });
                });
            } catch (error) {
                console.error('Error joining voice channel:', error);
            }
        } else {
            message.reply('You need to join a voice channel first!');
        }
    }
});

function calculateRMS(buffer) {
	  if (buffer.length % 2 !== 0) {
		    throw new error("Buffer length is not a multiple of 2");
		}
    let sum = 0;
    for (let i = 0; i < buffer.length; i += 2) {
        const value = buffer.readInt16LE(i);
        sum += value * value;
    }
    return Math.sqrt(sum / (buffer.length / 2));
}

function rmsToDecibels(rms) {
	const REFERENCE = 32767; // Max value for 16-bit audio
    return 20 * Math.log10(rms / REFERENCE);
}

client.login('replace_with_your_bot_token');
