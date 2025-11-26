const express = require('express')
const bodyParser = require('body-parser')
const fs = require('fs')
const path = require('path')
const axios = require('axios')
const crypto = require('crypto')
const {spawn} = require('child_process') // ffmpeg için
const OpenAI = require('openai')
require('dotenv').config()

const openai = new OpenAI({apiKey: process.env.OPENAI_API_KEY})

// ENV değişkenleri
const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY
const ELEVEN_VOICE_ID = process.env.ELEVEN_VOICE_ID
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL
const PORT = process.env.PORT || 9000
const ALEXA_SKILL_ID =
  process.env.ALEXA_SKILL_ID ||
  'amzn1.ask.skill.b1f16488-03fd-4f4b-b36f-0d9a84fff537' // kendi skill ID'n

if (!ELEVEN_API_KEY || !ELEVEN_VOICE_ID || !PUBLIC_BASE_URL) {
  console.error(
    'ENV eksik. ELEVEN_API_KEY, ELEVEN_VOICE_ID ve PUBLIC_BASE_URL ayarlı olmalı.',
  )
  process.exit(1)
}

// Express
const app = express()
app.use(bodyParser.json())

// TTS klasörü
const ttsDir = path.join(__dirname, 'tts')
if (!fs.existsSync(ttsDir)) {
  fs.mkdirSync(ttsDir, {recursive: true})
}
app.use('/tts', express.static(ttsDir))

/**
 * Basit health check
 */
app.get('/', (req, res) => {
  res.send('Alexa backend ayakta.')
})

/**
 * Alexa ana endpoint (/alexa)
 */
app.post('/alexa', async (req, res) => {
  try {
    const alexaRequest = req.body || {}
    const request = alexaRequest.request || {}

    console.log('=== ALEXA REQUEST ===')
    console.log(JSON.stringify(alexaRequest, null, 2))

    // Skill ID kontrolü (güvenlik amaçlı)
    const requestSkillId =
      alexaRequest.session?.application?.applicationId ||
      alexaRequest.context?.System?.application?.applicationId

    if (requestSkillId && requestSkillId !== ALEXA_SKILL_ID) {
      console.warn('Beklenmeyen skillId:', requestSkillId)
      return res.status(200).json(
        buildAlexaResponse({
          text: 'Unknown skill id.',
          shouldEndSession: true,
        }),
      )
    }

    const requestType = request.type

    // 1) Skill açılışı
    if (requestType === 'LaunchRequest') {
      return res.status(200).json(
        buildAlexaResponse({
          text: 'Merhaba, ben Mucahidin asistanıyım. Bir şey söyle.',
          shouldEndSession: false,
        }),
      )
    }

    // 2) IntentRequest → ChatIntent
    if (requestType === 'IntentRequest') {
      const intent = request.intent || {}
      const intentName = intent.name

      if (intentName === 'ChatIntent') {
        // AMAZON.SearchQuery slotundan gelen cümle
        const querySlot = intent.slots?.Query?.value || ''
        const userText = querySlot.trim()

        if (!userText) {
          return res.status(200).json(
            buildAlexaResponse({
              text: 'Seni duyamadım, lütfen tekrar söyle.',
              shouldEndSession: false,
            }),
          )
        }

        console.log('Kullanıcı cümlesi:', userText)

        // Şimdilik PARROT MODE: Kullanıcının söylediği aynen tekrar edilecek
        // GPT geçmişine ekle
        addToMemory('user', userText)

        // GPT cevabını üret
        const gptReply = await generateGPTReply(conversationHistory, userText)

        // Cevabı hafızaya ekle
        addToMemory('assistant', gptReply)

        // ElevenLabs’e gönderilecek metin
        const ttsText = gptReply

        // ElevenLabs TTS
        const mp3Url = await generateElevenLabsTTS(ttsText)

        if (!mp3Url) {
          return res.status(200).json(
            buildAlexaResponse({
              text: 'Ses oluşturmada bir problem oluştu.',
              shouldEndSession: true,
            }),
          )
        }

        // Alexa SSML cevabı
        const ssml = `<speak><audio src="${mp3Url}"/></speak>`

        return res.status(200).json(
          buildAlexaResponse({
            ssml,
            shouldEndSession: false,
          }),
        )
      }

      // Bilinmeyen intent
      return res.status(200).json(
        buildAlexaResponse({
          text: 'Bu isteği anlayamadım.',
          shouldEndSession: false,
        }),
      )
    }

    // 3) SessionEndedRequest → boş response dönmeliyiz
    if (requestType === 'SessionEndedRequest') {
      console.log('SessionEndedRequest:', request.reason, request.error || null)
      return res.status(200).json({
        version: '1.0',
        response: {},
      })
    }

    // Diğer durumlar
    return res.status(200).json(
      buildAlexaResponse({
        text: 'Beklenmeyen bir istek tipi aldım.',
        shouldEndSession: true,
      }),
    )
  } catch (err) {
    console.error('Hata (/alexa):', err)
    // Alexa'ya HER ZAMAN 200 + geçerli JSON dön
    return res.status(200).json(
      buildAlexaResponse({
        text: 'Bir hata oluştu.',
        shouldEndSession: true,
      }),
    )
  }
})

/**
 * ffmpeg ile ElevenLabs MP3'ünü Alexa uyumlu MP3'e dönüştürme
 */
async function convertToAlexaCompatibleMp3(inputBuffer) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      'pipe:0', // stdin'den input
      '-ac',
      '2', // stereo
      '-codec:a',
      'libmp3lame',
      '-b:a',
      '48k', // 48 kbps
      '-ar',
      '24000', // 24 kHz (Alexa destekli)
      '-write_xing',
      '0', // bazı metadata sorunlarını önlemek için
      '-f',
      'mp3',
      'pipe:1', // stdout'a output
    ])

    const chunks = []

    ff.stdout.on('data', chunk => {
      chunks.push(chunk)
    })

    ff.stderr.on('data', data => {
      console.error('ffmpeg:', data.toString())
    })

    ff.on('close', code => {
      if (code === 0) {
        resolve(Buffer.concat(chunks))
      } else {
        reject(new Error('ffmpeg exited with code ' + code))
      }
    })

    ff.stdin.write(inputBuffer)
    ff.stdin.end()
  })
}

/**
 * ElevenLabs TTS → ffmpeg ile Alexa'ya uygun MP3
 */
async function generateElevenLabsTTS(text) {
  try {
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}/stream`

    const payload = {
      text,
      // DİL ZORLAMA İÇİN MODEL
      model_id: 'eleven_flash_v2_5', // istersen 'eleven_turbo_v2_5' de deneyebilirsin
      // TÜRKÇEYİ ZORLA
      language_code: 'tr',
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.8,
      },
      output_format: 'mp3_44100_128',
    }

    const response = await axios.post(url, payload, {
      headers: {
        'xi-api-key': ELEVEN_API_KEY,
        'Content-Type': 'application/json',
      },
      responseType: 'arraybuffer',
      timeout: 7000, // Alexa timeout'una takılmamak için
    })

    if (response.status !== 200) {
      console.error(
        'ElevenLabs hata:',
        response.status,
        response.data?.toString?.(),
      )
      return null
    }

    // ElevenLabs'ten gelen orijinal veri
    const originalBuffer = Buffer.from(response.data)

    // Alexa uyumlu hale dönüştür
    const alexaBuffer = await convertToAlexaCompatibleMp3(originalBuffer)

    const filename = crypto.randomUUID() + '.mp3'
    const filepath = path.join(ttsDir, filename)

    fs.writeFileSync(filepath, alexaBuffer)

    const fileUrl = `${PUBLIC_BASE_URL}/tts/${filename}`
    console.log('Oluşan ALEXA MP3 URL:', fileUrl)

    return fileUrl
  } catch (err) {
    console.error(
      'generateElevenLabsTTS error:',
      err.response?.status,
      err.response?.data?.toString?.() || err.message,
    )
    return null
  }
}

/**
 * Alexa response builder
 */
function buildAlexaResponse({text, ssml, shouldEndSession}) {
  const response = {
    shouldEndSession: !!shouldEndSession,
  }

  // Eğer text veya ssml varsa outputSpeech ekle
  if (text || ssml) {
    response.outputSpeech = ssml
      ? {type: 'SSML', ssml}
      : {type: 'PlainText', text: text || ''}
  }

  return {
    version: '1.0',
    sessionAttributes: {},
    response: response,
  }
}

app.listen(PORT, () => {
  console.log(`Alexa backend port ${PORT} üzerinde çalışıyor. PORT=${PORT}`)
})

async function generateGPTReply(history, userText) {
  try {
    const messages = [
      {
        role: 'system',
        content:
          'Sen Mucahid’in kişisel sesli asistanısın. Samimi ve kısa yanıt ver.',
      },
      ...history,
      {role: 'user', content: userText},
    ]

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: messages,
      max_tokens: 200,
    })

    return completion.choices[0].message.content
  } catch (err) {
    console.error('GPT error:', err)
    return 'Üzgünüm Mucahid, şu anda yanıt üretemiyorum.'
  }
}

let conversationHistory = []

function addToMemory(role, content) {
  conversationHistory.push({role, content})

  // sadece son 1 gün tutulacak
  const oneDay = 1000 * 60 * 60 * 24
  const cutoff = Date.now() - oneDay

  conversationHistory = conversationHistory
    .filter(m => m.timestamp >= cutoff)
    .map(m => ({
      role: m.role,
      content: m.content,
      timestamp: m.timestamp || Date.now(),
    }))

  // maksimum 30 mesaj tut
  if (conversationHistory.length > 30) {
    conversationHistory = conversationHistory.slice(-30)
  }
}
