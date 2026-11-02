import assert from 'node:assert/strict'
import test from 'node:test'

import { Renderer } from '../lib/renderer.js'

function createHarness({ config: configOverrides = {}, replyMode = { direct: 'aicard', group: 'aicard' } } = {}) {
  const finished = []
  const failed = []
  const sent = []
  const card = {
    async stream() {},
    async finish(text) {
      finished.push(text)
    },
    async fail(text) {
      failed.push(text)
    },
  }
  const renderer = new Renderer({
    config: {
      replyMode,
      streaming: { enabled: true, throttleMs: 1, maxCardChars: 20_000 },
      asyncMode: false,
      ackText: 'ack',
      markdownTitle: 'DSH',
      emotionFirstResponse: false,
      ...configOverrides,
    },
    outbound: {
      async sendMarkdown(_webhook, _title, text) {
        sent.push(text)
        return true
      },
      async sendText(_webhook, text) {
        sent.push(text)
        return true
      },
    },
    emotion: { async recall() {} },
    async createCard() {
      return card
    },
    log() {},
  })
  const msg = {
    msgId: 'm1',
    conversationId: 'c1',
    conversationType: 'direct',
    senderStaffId: 'u1',
    senderNick: 'Raph',
    text: '你好',
    createAt: '1',
    sessionWebhook: 'https://example.test',
  }
  return { renderer, msg, finished, failed, sent }
}

function assistantMessage(text) {
  return { type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } }
}

function textChunk(text) {
  return { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text } } }
}

async function settleTurn(harness, events, reason = { kind: 'completed' }) {
  const settled = harness.renderer.onInbound('s1', harness.msg)
  for (const event of events) harness.renderer.onSessionEvent({ id: 's1' }, event)
  harness.renderer.onSessionEvent({ id: 's1' }, { type: 'turn/end', data: { reason } })
  await settled
  await new Promise((resolve) => setImmediate(resolve))
}

test('默认 all：多段 assistant 文本全部聚合进定稿', async () => {
  const harness = createHarness()

  await settleTurn(harness, [assistantMessage('先改 config 结构：'), assistantMessage('迁移干净，收工。')])

  assert.equal(harness.finished.length, 1)
  assert.equal(harness.finished[0], '先改 config 结构：\n\n迁移干净，收工。')
})

test('last：定稿只保留最后一段，中间进度叙述不进最终回复', async () => {
  const harness = createHarness({ config: { finalTextPolicy: 'last' } })

  await settleTurn(harness, [
    assistantMessage('先改 config 结构：'),
    assistantMessage('沙箱测多任务机制：'),
    assistantMessage('迁移干净，收工。'),
  ])

  assert.equal(harness.finished.length, 1)
  assert.equal(harness.finished[0], '迁移干净，收工。')
})

test('last：没有任何 assistant/message 时回落到流式 live 文本', async () => {
  const harness = createHarness({ config: { finalTextPolicy: 'last' } })

  await settleTurn(harness, [textChunk('只有 chunk 的正文')])

  assert.equal(harness.finished.length, 1)
  assert.equal(harness.finished[0], '只有 chunk 的正文')
})

test('last：markdown 模式一次性消息同样只发最后一段', async () => {
  const harness = createHarness({
    config: { finalTextPolicy: 'last' },
    replyMode: { direct: 'markdown', group: 'markdown' },
  })

  await settleTurn(harness, [assistantMessage('中间旁白'), assistantMessage('最终答复')])

  assert.deepEqual(harness.sent, ['最终答复'])
  assert.equal(harness.finished.length, 0)
})

test('all：显式配置与默认行为一致', async () => {
  const harness = createHarness({ config: { finalTextPolicy: 'all' } })

  await settleTurn(harness, [assistantMessage('第一段'), assistantMessage('第二段')])

  assert.equal(harness.finished[0], '第一段\n\n第二段')
})
