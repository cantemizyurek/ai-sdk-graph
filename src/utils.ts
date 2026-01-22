import type { StreamTextResult, UIMessage } from 'ai'
import type { GraphSDK } from './types'

export const GRAPH_DATA_PART_TYPES = [
    'data-state',
    'data-node-start',
    'data-node-end',
    'data-node-suspense',
] as const

export type GraphDataPartType = (typeof GRAPH_DATA_PART_TYPES)[number]

export function isGraphDataPart(part: { type: string }): boolean {
    return GRAPH_DATA_PART_TYPES.includes(part.type as GraphDataPartType)
}

export function stripGraphDataParts<T extends UIMessage>(messages: T[]): T[] {
    return messages.map((msg) => ({
        ...msg,
        parts: msg.parts.filter((part) => !isGraphDataPart(part)),
    })) as T[]
}

export async function consumeAndMergeStream<Stream extends StreamTextResult<any, any>>(
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