require('dotenv').config();
const fs = require('fs');
const path = require('path');
const util = require('util');

const {
    Client,
    GatewayIntentBits,
    REST,
    Routes,
    SlashCommandBuilder,
    Events,
    NewsChannel,
    ChannelType,
    VoiceState,
    PermissionsBitField,
    GuildMember
} = require('discord.js');

const {
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    getVoiceConnection
} = require('@discordjs/voice');

const textToSpeech = require('@google-cloud/text-to-speech');
const { josa } = require('es-hangul');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates
    ]
});

const ttsClient = new textToSpeech.TextToSpeechClient();

/**@type {import('discord.js').User} */
let dev = null;

/* ===================== 음성 목록 ===================== */

const voices = {
    female: 'ko-KR-Standard-A',
    male: 'ko-KR-Standard-B',
    calm: 'ko-KR-Wavenet-A'
};

/* ===================== 전역 상태 ===================== */

const queues = {};          // queues[guildId][textChannelId]
const players = {};         // players[guildId]
const playing = {};         // playing[guildId]
const targetTextChannel = {}; // guildId -> channelId

/* ===================== JSON 유틸 ===================== */

function loadJSON(file, def) {
    if (!fs.existsSync(file)) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(def, null, 2));
        return def;
    }
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function saveJSON(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

/* ===================== 설정 ===================== */

function getGuildConfig(guildId) {
    return loadJSON(
        `./DB/${guildId}/config.json`,
        {
            defaultVoice: 'female',
            defaultSpeed: 1.0,
            defaultPitch: 0
        }
    );
}

function getUserConfig(guildId, userId) {
    const guild = getGuildConfig(guildId);
    return loadJSON(
        `./DB/${guildId}/users/${userId}.json`,
        {
            voice: guild.defaultVoice,
            speed: guild.defaultSpeed,
            pitch: guild.defaultPitch
        }
    );
}

function saveUserConfig(guildId, userId, data) {
    saveJSON(`./DB/${guildId}/users/${userId}.json`, data);
}

/* ===================== 큐 ===================== */

function getQueue(guildId, channelId) {
    queues[guildId] ??= {};
    queues[guildId][channelId] ??= [];
    return queues[guildId][channelId];
}

/* ===================== TTS 재생 ===================== */

async function processQueue(guildId, channelId) {
    if (playing[guildId]) return;

    const queue = getQueue(guildId, channelId);
    if (queue.length === 0) return;

    playing[guildId] = true;
    players[guildId] ??= createAudioPlayer();

    const { text, userId } = queue.shift();
    const setting = getUserConfig(guildId, userId);

    const request = {
        input: { text },
        voice: {
            languageCode: 'ko-KR',
            name: voices[setting.voice]
        },
        audioConfig: {
            audioEncoding: 'MP3',
            speakingRate: setting.speed,
            pitch: setting.pitch
        }
    };

    try {
        const [res] = await ttsClient.synthesizeSpeech(request);
        const file = `./tts_${Date.now()}_${guildId}.mp3`;
        await util.promisify(fs.writeFile)(file, res.audioContent, 'binary');

        players[guildId].play(createAudioResource(file));

        players[guildId].once(AudioPlayerStatus.Idle, () => {
            fs.existsSync(file) && fs.unlinkSync(file);
            playing[guildId] = false;
            processQueue(guildId, channelId);
        });

    } catch (e) {
        console.error(e);
        playing[guildId] = false;
    }
}
/**
 * 
 * @param {String} filepath 로그파일 위치
 * @param {String} text 로그 메세지
 */
async function log(filepath, text) {
    let data = await fs.readFileSync(filepath);
    data = data + ("\n"+text);
    await fs.writeFileSync(filepath,data);
}

const isValidURL = (string) => {
  try {
    new URL(string);
    return true;
  } catch (err) {
    return false;
  }
};
/* ===================== Slash Commands ===================== */

const commands = [
    new SlashCommandBuilder()
        .setName('들어와')
        .setDescription('음성 채널에 들어갑니다.'),

    new SlashCommandBuilder()
        .setName('나가')
        .setDescription('음성 채널에서 나옵니다.'),

    new SlashCommandBuilder()
        .setName('설정공유')
        .setDescription('설정공유')
        .addSubcommand(sub=>sub
            .setName('공유')
            .setDescription('자신의 TTS 설정을 공유합니다.')
        )
        .addSubcommand(sub=>sub
            .setName('적용')
            .setDescription('다른 사람의 TTS 설정을 적용합니다.')
            .addStringOption(o=>o
                .setName('공유코드')
                .setDescription('다른 사람이 공유해준 공유코드를 입력하세요.')
                .setRequired(true)
            )
        ),
    new SlashCommandBuilder()
        .setName('설정')
        .setDescription('TTS 설정')
        .addStringOption(o =>
            o.setName('음성')
            .setDescription('목소리 종류를 선택하세요.')
            .addChoices(
               { name: '1', value: 'female' },
               { name: '2', value: 'male' },
               { name: '3', value: 'calm' }
            )
        )
        .addNumberOption(o =>
            o.setName('속도')
            .setDescription('말하기 속도 (0.25 ~ 4.0)')
             .setMinValue(0.25)
             .setMaxValue(4.0)
        )
        .addNumberOption(o =>
            o.setName('피치')
            .setDescription('목소리 높낮이 (-20 ~ 20)')
             .setMinValue(-20)
             .setMaxValue(20)
        ),
    new SlashCommandBuilder()
        .setName('이동')
        .setDescription('멤버나 자기자신을 다른 음성채널로 이동시킵니다.')
        .addChannelOption(o=>o
            .setName('채널')
            .setDescription('이동할 채널을 선택해주세요')
            .addChannelTypes(ChannelType.GuildVoice)
            .setRequired(true)
        )
        .addUserOption(o=>o
            .setName('대상')
            .setDescription('이동시킬 대상, 미선택시 자기자신')
            .setRequired(false)
        ),
    new SlashCommandBuilder()
        .setName('개발자')
        .setDescription('개발자')
        .addSubcommand(sub=>sub
            .setName('공지')
            .setDescription('공지를 보냅니다')
            .addStringOption(o=>o
                .setChoices(
                    { name: '서버주인에게만', value:'onlyserverowner' },
                    { name: '음성채널에', value: 'voicechannel'}
                )
                .setName('전송대상')
                .setDescription('전송대상을 선택하세요')
                .setRequired(true)
            )
            .addStringOption(o=>o
                .setName('내용')
                .setDescription('공지의 내용')
                .setMinLength(1)
                .setMaxLength(2000)
                .setRequired(true)
            )
        )
        .addSubcommand(sub=>sub
            .setName('들어가')
            .setDescription('특정채널에 봇을 강제로 참여시킵니다')
            .addChannelOption(o=>o
                .setName('음성채널')
                .setDescription('들어갈 음성채널')
                .addChannelTypes(ChannelType.GuildVoice,ChannelType.GuildStageVoice)
                .setRequired(true)
            )
            .addChannelOption(o=>o
                .setName('채팅채널')
                .setDescription('읽어줄 일반채널')
                .addChannelTypes(ChannelType.GuildText,ChannelType.PublicThread,ChannelType.PrivateThread, ChannelType.GuildVoice, ChannelType.GuildStageVoice)
                .setRequired(true)
            )
        )
]

/* ===================== Discord Client ===================== */
client.once(Events.ClientReady, async () => {
    await client.application.commands.set(commands);
    console.log('Bot is ready!');
    dev = await client.users.fetch(process.env.devId);
});

/* ===================== Guild Join ===================== */
client.on(Events.GuildCreate, async (guild) => {
    (await guild.members.fetch(guild.ownerId)).send("저는 TTS봇입니다가 추가되었어요!");

});

/* ===================== Interaction ===================== */

client.on(Events.InteractionCreate, async i => {
    if (!i.isChatInputCommand()) return;
        await log("log.log",`[${(Math.floor(Date.now()/1000))}]${i.user.id} used ${i.commandName}`)
    if (i.commandName === '들어와') {
        const vc = i.member.voice.channel;
        if (!vc) return i.reply({ content: '음성 채널에 먼저 들어가세요.', ephemeral: true });

        const conn = joinVoiceChannel({
            channelId: vc.id,
            guildId: vc.guild.id,
            adapterCreator: vc.guild.voiceAdapterCreator
        });

        players[i.guildId] ??= createAudioPlayer();
        conn.subscribe(players[i.guildId]);
        targetTextChannel[i.guildId] = i.channelId;
        await i.guild.members.me.voice?.setDeaf(true);

        return i.reply({ content: '음성 채널에 접속했습니다.', ephemeral: true });
    }

    if (i.commandName === '나가') {
        const conn = getVoiceConnection(i.guildId);
        if (i.member.voice.channel.id !== conn.joinConfig.channelId) return i.reply({content: '음성채널에 들어가야지 봇을 퇴장시킬 수 있습니다.', flags:["Ephemeral"]});
        if (conn) conn.destroy();
        delete targetTextChannel[i.guildId];
        return i.reply({ content: '퇴장했습니다.', ephemeral: true });
    }

    if (i.commandName === '이동') {
        const imember = i.member;
        /**@type {import('discord.js').GuildTextBasedChannel} */
        const ch = i.options.getChannel('채널');

        const target = i.options.getMember('대상');
        if (!ch) return i.reply({content: "존재하지 않는 채널입니다."});

        await i.deferReply({flags:["Ephemeral"]});

        if (!target || target.id === i.user.id) { // 자기자신을 이동시키는 경우
            const chperms = ch.permissionsFor(imember).has(PermissionsBitField.Flags.Connect) && ch.permissionsFor(imember).has(PermissionsBitField.Flags.ViewChannel);
            if (!chperms) return i.editReply({content: '이 채널은 당신이 접속할 수 없는 채널입니다.'});

            i.member.voice.setChannel(ch)
            .then(()=>i.editReply(`${ch.name}채널로 이동했습니다`))
            .catch(err => {
                i.editReply('오류가 발생했습니다! 나중에 다시 시도해주세요')
                console.error(err+"");
            });
        } else {
            if (!imember.permissions.has(PermissionsBitField.Flags.MoveMembers)) return i.editReply('이 명령어를 사용할 권한이 없습니다. 본인을 선택하거나 권한을 부여받으십시오.');
            target.voice.setChannel(ch)
            .then(()=>i.editReply(`${target.displayName}님을 ${ch.name}채널로 이동했습니다`))
            .catch(err => {
                i.editReply('오류가 발생했습니다! 나중에 다시 시도해주세요')
                console.error(err+"");
            });
        }
    }

    if (i.commandName === '설정') {
        const cfg = getUserConfig(i.guildId, i.user.id);

        const voice = i.options.getString('음성');
        const speed = i.options.getNumber('속도');
        const pitch = i.options.getNumber('피치');

        if (voice) cfg.voice = voice;
        if (speed !== null) cfg.speed = speed;
        if (pitch !== null) cfg.pitch = pitch;

        saveUserConfig(i.guildId, i.user.id, cfg);

        return i.reply({
            content: `설정 완료\n음성: ${cfg.voice}\n속도: ${cfg.speed}\n피치: ${cfg.pitch}`,
            ephemeral: true
        });
    }

    if (i.commandName === "설정공유"){
        if (i.options.getSubcommand()==="공유"){
            await i.deferReply({flags:["Ephemeral"]})
            const file = await fs.existsSync(`./DB/${i.guild.id}/share.json`);
            if(!file){await fs.writeFileSync(`./DB/${i.guild.id}/share.json`,"{}")}
            const data = await fs.readFileSync(`./DB/${i.guild.id}/share.json`);
            const userdata = await getUserConfig(i.guild.id,i.user.id);
            const jsondata = JSON.parse(data);
            jsondata[i.user.id]={
                voice: userdata.voice,
                pitch: userdata.pitch,
                speed: userdata.speed
            }
            await fs.writeFileSync(`./DB/${i.guild.id}/share.json`,JSON.stringify(jsondata,null,2));
            await i.editReply(`공유가 끝났습니다. 당신의 설정을 다른사람이 적용할려면 \`${i.member.id}\`를 입력하세요.`)
        }
        if (i.options.getSubcommand()==="적용"){
            await i.deferReply({flags:["Ephemeral"]})
            const data = await fs.readFileSync(`./DB/${i.guild.id}/share.json`);
            const code = i.options.getString('공유코드');
            if (!JSON.parse(data)[code]){
                return await i.editReply('올바르지 않은 공유코드입니다.');
            }
            await saveUserConfig(i.guild.id,i.user.id,JSON.parse(data)[code]);
            await i.editReply(`적용이 끝났습니다.`)
        }
    }

    if (i.commandName === '개발자') {
        if (i.user.id === process.env.devId)
        switch (i.options.getSubcommand()) {
            case "공지":{
                await i.deferReply({flags:["Ephemeral"]});
                if (i.options.getString('전송대상') === "onlyserverowner")
                await i.client.guilds.cache.forEach(async (g) => {
                    await (await g.members.fetch(g.ownerId)).send(i.options.getString('내용'));
                });

                if (i.options.getString('전송대상') === "voicechannel")
                await i.client.guilds.cache.forEach(async (g) => {
                    const c = await getVoiceConnection(g.id);
                    if (!c) {
                        await (await g.members.fetch(g.ownerId)).send(i.options.getString('내용'));
                    }
                    else {
                        await (await g.channels.fetch(c.joinConfig.channelId)).send(i.options.getString('내용'))
                    }
                });

                break;
            }
            case "들어가":{
                /**@type {import('discord.js').ChannelType.GuildVoice} */
                        const vc = i.options.getChannel('음성채널');

        const conn = joinVoiceChannel({
            channelId: vc.id,
            guildId: vc.guild.id,
            adapterCreator: vc.guild.voiceAdapterCreator
        });

        players[i.guildId] ??= createAudioPlayer();
        conn.subscribe(players[i.guildId]);
        targetTextChannel[i.guildId] = i.options.getChannel('채팅채널').id;
        await i.guild.members.me.voice?.setDeaf(true);

        return i.reply({ content: `음성 채널에 접속했습니다. vcid:${vc.id}, tcid:${i.options.getChannel('채팅채널').id}`, ephemeral: true });
    
            }
            default:
                break;
        }
    }
});

/* ===================== Message TTS ===================== */

client.on(Events.MessageCreate, async (msg) => {
    if (msg.author.bot) return;
    if (targetTextChannel[msg.guildId] !== msg.channel.id) return;
    if (!getVoiceConnection(msg.guildId)) return;
    if (msg.content.startsWith("//")) return;
    if (msg.content.length > 200) return await msg.react('❌');
    
    let text = msg.content
        .replace(/<@!?(\d+)>/g, (_, id) => {
            const m = msg.guild.members.cache.get(id);
            return m ? `${m.displayName}님을 언급했어요.` : '누군가를 언급했어요.';
        })
        .replace(/\*\*(.*?)\*\*/g, (_, t) => `${josa(t, '을/를')} 강조했어요.`)
        .replace(/[*_~`]/g, '')
        .replace(/<?:[A-Za-z0-9_]+:(\d{17,19})?\>?/g, '이모지를 보냈어요.') 
        .replace(/https?:\/\/[^\s]+/g,"링크를 보냈어요.")
        .replaceAll("ㅎㅇ","하이")
        .replaceAll("ㅅㄲ","새끼")
        .replaceAll("ㅂㅇ","바이")
        .replaceAll("ㅅㅂ","시발")
        .replaceAll("ㅇㄴ","아니")
        .replaceAll("ㅈㄴ","존나")
        .replaceAll("ㅅㄱ","수고")
        .replaceAll("ㅂㅅ","병신")
        .replaceAll("ㅄ","병신")
        .replaceAll("ㄳ","감사")
        .replaceAll("ㄱㅅ","감사")
        .replaceAll("ㄱㄴㄲ","그니까")
        .replaceAll("ㄱㄴ","가능")
        .replaceAll("ㄱㅅㄲ","개새끼")
        .replaceAll("ㅗ","엿")
        .replaceAll("ㅅㅅ","섹스")
        .replaceAll("ㄹㅇ","레알")
        .replaceAll("ㅈㅅ","죄송")
        .replaceAll(" "," ") // 양식용으로 남겨놓깅
        .replaceAll("ㅊㅇ","차이");
    if (msg.attachments.size > 0) {
        const queue = getQueue(msg.guildId, msg.channel.id);
        queue.push({ text:"파일을 보냈어요", userId: msg.author.id });
    }
    const queue = getQueue(msg.guildId, msg.channel.id);
    queue.push({ text, userId: msg.author.id });

    processQueue(msg.guildId, msg.channel.id);
});

/* ===================== ERROR CHACH ===================== */
client.on(Events.Error, async (error) => {
    const _msg = await dev.send(`에러발생\n에러이름: ${error.name}\n에러사유: ${error.cause}\n에러메세지: ${error.message}\n에러객체:\`\`\`json\n${JSON.stringify(error, null, 2)}\`\`\``);
    console.error(`[ERROR] ${error.name} error raised. Check this(${_msg.url}) message.`);
})
/* ===================== Login ===================== */

client.login(process.env.DISCORD_TOKEN);
