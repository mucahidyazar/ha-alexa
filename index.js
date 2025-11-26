// proxy.js
const express = require('express')
const bodyParser = require('body-parser')
const fetch = require('node-fetch') // veya global fetch Node 18+
require('dotenv').config()

const APP_KEY = process.env.APP_KEY
const HA_TOKEN = process.env.HA_TOKEN
const HA_BASE = process.env.HA_BASE || 'https://ha.mucahid.dev'

const ALLOWED = {
  turn_off_tv: '/api/webhook/gpt_turn_off_tv',
  set_brightness: '/api/webhook/gpt_set_livingroom_brightness',
}

const app = express()
app.use(bodyParser.json())

app.post('/run', async (req, res) => {
  const key = req.headers['x-app-key']
  if (!key || key !== APP_KEY)
    return res.status(401).json({error: 'Unauthorized'})

  const {action} = req.body
  if (!action || !action.name)
    return res.status(400).json({error: 'missing action'})

  const webhookPath = ALLOWED[action.name]
  if (!webhookPath) return res.status(403).json({error: 'forbidden action'})

  // Example validation
  if (action.name === 'set_brightness') {
    const pct = action.params?.brightness_pct
    if (typeof pct !== 'number' || pct < 0 || pct > 100) {
      return res.status(400).json({error: 'invalid brightness_pct'})
    }
  }

  try {
    const resp = await fetch(HA_BASE + webhookPath, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${HA_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(action.params || {}),
    })
    const text = await resp.text()
    res.status(resp.status).send(text)
  } catch (err) {
    console.error(err)
    res.status(500).json({error: 'server_error'})
  }
})

app.listen(process.env.PORT || 3000, () => console.log('proxy listening'))
