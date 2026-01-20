import type { StreamTextResult, ToolSet, UIMessage } from 'ai'
import type { GraphSDK } from './types'

export async function consumeAndMergeStream<Stream extends StreamTextResult<ToolSet, any>>(
    stream: Stream,
    writer: GraphSDK.Writer,
    options?: Omit<Parameters<Stream['toUIMessageStream']>[0], 'onFinish' | 'onError'>
) {
    let resolver: (messages: UIMessage[]) => void
    let rejecter: (error: unknown) => void
    const messages = new Promise<UIMessage[]>((resolve, reject) => {
        resolver = resolve
        rejecter = reject
    })

    try {
        const uiMessageStream = stream.toUIMessageStream({
            ...options,
            onFinish: ({ messages }) => {
                resolver(messages)
            },
            onError: (error) => {
                rejecter(error)
                return error instanceof Error ? error.message : 'An error occurred.'
            }
        })
        writer.merge(uiMessageStream)
    } catch (error) {
        rejecter!(error)
    }

    return messages
}