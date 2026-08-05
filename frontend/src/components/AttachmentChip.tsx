import type { Attachment } from '../types'
import { AlertIcon, CloseIcon, FileIcon } from './icons'

interface AttachmentChipProps {
  attachment: Attachment
  /** Omitted for chips on a sent message, which are no longer removable. */
  onRemove?: (id: string) => void
}

/** `1.2 kB`, `340 B` — short enough to sit on a chip without wrapping. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} kB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export default function AttachmentChip({ attachment, onRemove }: AttachmentChipProps) {
  const failed = Boolean(attachment.error)

  return (
    <div className="chip" data-error={failed || undefined} title={attachment.error ?? attachment.filename}>
      {failed ? (
        <AlertIcon className="h-3.5 w-3.5 shrink-0" />
      ) : (
        <FileIcon className="h-3.5 w-3.5 shrink-0" />
      )}

      <span className="chip-name">{attachment.filename}</span>

      <span className="chip-meta">
        {attachment.uploading
          ? 'reading…'
          : failed
            ? 'not attached'
            : // Token cost matters more than file size here: it is what decides
              // whether the file fits alongside the conversation.
              attachment.estimatedTokens
              ? `~${attachment.estimatedTokens.toLocaleString()} tokens`
              : formatBytes(attachment.byteSize)}
      </span>

      {onRemove && (
        <button
          className="chip-remove"
          onClick={() => onRemove(attachment.id)}
          aria-label={`Remove ${attachment.filename}`}
          title="Remove"
        >
          <CloseIcon className="h-3 w-3" />
        </button>
      )}
    </div>
  )
}
