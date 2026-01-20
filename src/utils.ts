import type { StreamTextResult, ToolSet, UIMessage } from 'ai'
import type { GraphSDK } from './types'

export async function consumeAndMergeStream<Stream extends StreamTextResult<ToolSet, any>>(
    stream: Stream,
    writer: GraphSDK.Writer,
    options?: Omit<Parameters<Stream['toUIMessageStream']>[0], 'onFinish'>
) {
    let resolver: (messages: UIMessage[]) => void
    const messages = new Promise<UIMessage[]>((resolve) => {
        resolver = resolve
    })
    writer.merge(stream.toUIMessageStream({
        ...options,
        onFinish: ({ messages }) => {
            resolver(messages)
        }
    }))
    return messages
}