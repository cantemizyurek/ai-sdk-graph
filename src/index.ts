import { graph } from './graph'

const g = graph<{ name: string }>()
  .node('a', ({ state }) => {
    console.log('a', state())
  })
  .node('b', ({ state, suspense, update }) => {
    if (state().name === 'b') {
      console.log('suspense b', state())
      suspense({ message: 'user input required name is not valid' })
    }

    console.log('b', state())

    update({
      name: 'a'
    })

    console.log('b', state())
  })
  .node('c', ({ state }) => {
    console.log('c', state())
  })
  .edge('START', 'a')
  .edge('a', 'b')
  .edge('b', 'c')
  .edge('c', 'END')

async function consumeStream(stream: ReadableStream) {
  const reader = stream.getReader()
  while (true) {
    const { done } = await reader.read()
    if (done) break
  }
}

async function run() {
  // First execution - will suspend at node 'b'
  const stream1 = g.execute('run-1', { name: 'b' })
  await consumeStream(stream1)

  console.log('--- resuming after suspense ---')

  // Second execution - resumes from checkpoint with updated state
  const stream2 = g.execute('run-1', (state) => ({ ...state, name: 'c' }))
  await consumeStream(stream2)
}

run()
