import { useTranslate } from '../../i18n/index.js'
import { isAnthropicProtocol, useSettings } from '../../services/settings.js'
import {
  describeReadAloudError,
  toggleReadAloud,
  useReadAloud,
} from '../../services/speech/readAloud.js'
import { IconPlayMediaOutline16 } from '../base/icons.js'
import { IconButton } from '../base/IconButton.js'
import { showToast } from '../base/toastState.js'
import { ReadingBars } from './ReadingBars.js'

/**
 * 朗读按钮：未朗读时点击开始，加载中或朗读中点击停止；正文原样提交，由服务端过滤 markdown。
 * `/v1/tools/tts` 只存在于 Anthropic 兼容协议，OpenAI 兼容下置灰而不是等 404。
 */
export const ReadAloudButton = ({ messageId, text }: { messageId: string; text: string }) => {
  const t = useTranslate()
  const anthropic = isAnthropicProtocol(useSettings((state) => state.endpoint.protocol))
  const status = useReadAloud((state) => (state.messageId === messageId ? state.status : 'idle'))
  return (
    <IconButton
      icon={status === 'idle' ? <IconPlayMediaOutline16 /> : <ReadingBars mode={status} />}
      tooltip={!anthropic ? t('protocolNoTts') : status === 'idle' ? t('ttsPlay') : t('ttsStop')}
      tooltipPlacement="bottom"
      disabled={!anthropic}
      onClick={() =>
        toggleReadAloud(messageId, text, (error) => showToast(describeReadAloudError(error)))
      }
    />
  )
}
