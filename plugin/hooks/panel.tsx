/* @jsxRuntime classic */
/* @jsx h */
/* @jsxFrag Fragment */
import type { Elements, RenderChildren, RenderElement } from 'claude-code'

// One panel of the band, drawn the way Textual draws a widget with a border
// title: a round border, the title over its top edge, an optional subtitle
// over its bottom edge. Music, today and hum each draw their panels with a
// copy of this file and lay them in one row: each passes `next(e)` into the
// row's remaining space, so the three share the band from left to right.

/** The tags a panel draws with. */
export type PanelKit = Pick<Elements['terminal'], 'Box' | 'Text'>

/**
 * The ditto statusline's palette, shared by the three mods: its lavender body
 * for titles, its highlight for text, darker lavenders for the quiet parts.
 * Warnings and errors follow the person's theme, like the statusline's.
 */
export const COLOR = {
  text: '#ece0fa',
  label: '#8e7ba8',
  muted: '#9a8fad',
  line: '#5e4f70',
  title: '#c3a1e6',
  warn: 'warning',
  error: 'error',
} as const

/** What the panel says: quiet, a value worth a look, or a failure (the only tone that colors the border). */
export type Tone = 'normal' | 'warn' | 'error' | 'dim'

/** The cells the border and its padding take across a panel. */
export const FRAME_CELLS = 4

/** A run of text in one color: the body of a panel is a list of these. */
export type Seg = { text: string; color: string; bold?: boolean }

export type PanelSpec = {
  title: string
  subtitle?: string
  tone?: Tone
  /** Fixed columns, frame included; without it the panel grows into the free space. */
  width?: number
}

/**
 * One panel: the round border around `body`, the title and subtitle over it.
 *
 * @param kit Box and Text
 * @param spec title, subtitle, tone and width
 * @param body the tree inside the border
 * @returns the tree
 */
export function panelOf(kit: PanelKit, spec: PanelSpec, body: RenderChildren): RenderElement {
  const { Box, Text } = kit
  const tone = spec.tone ?? 'normal'
  // A value worth a look colors only that value; the border changes for a failure alone.
  const border = tone === 'error' ? COLOR.error : COLOR.line
  const size = spec.width === undefined ? { flexGrow: 1, flexShrink: 1 } : { width: spec.width, flexShrink: 0 }

  return (
    <Box flexDirection="column" {...size}>
      <Box key="body" flexDirection="column" borderStyle="round" borderColor={border} paddingX={1}>
        {body}
      </Box>
      <Box position="absolute" top={0} left={2}>
        <Text color={tone === 'dim' ? COLOR.muted : COLOR.title} bold>
          {` ${spec.title} `}
        </Text>
      </Box>
      {spec.subtitle ? (
        <Box position="absolute" top={2} right={2}>
          <Text color={COLOR.muted}>{` ${spec.subtitle} `}</Text>
        </Box>
      ) : null}
    </Box>
  )
}

/**
 * Segments as one line of Text, cut at the end when the panel is narrower.
 *
 * @param kit Box and Text
 * @param segs the runs
 * @returns the tree
 */
export function lineOf(kit: PanelKit, segs: readonly Seg[]): RenderElement {
  const { Text } = kit

  return (
    <Text wrap="truncate-end">
      {segs.map(seg => (
        <Text color={seg.color} bold={seg.bold ?? false}>
          {seg.text}
        </Text>
      ))}
    </Text>
  )
}

/**
 * The cells segments take, a CJK or emoji character two.
 *
 * @param segs the runs
 * @returns the cells
 */
export function cellsOf(segs: readonly Seg[]): number {
  let cells = 0

  for (const seg of segs) {
    for (const char of seg.text) {
      cells += WIDE.test(char) ? 2 : 1
    }
  }

  return cells
}

const WIDE =
  /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{1F300}-\u{1FAFF}]/u

/**
 * This mod's panels, then what the plugins beneath draw, in one row.
 *
 * A mod whose panels grow into the free space passes `isLast`: the space for
 * what is beneath then keeps to its content instead of taking a share.
 *
 * @param kit Box and Text
 * @param mine this mod's panels
 * @param beneath `next(e)`'s tree
 * @param isLast true when this mod's panels fill the rest of the row
 * @returns the tree
 */
export function rowOf(kit: PanelKit, mine: RenderChildren, beneath: RenderChildren, isLast = false): RenderElement {
  const { Box } = kit

  return (
    <Box flexDirection="row" flexGrow={1}>
      {mine}
      <Box flexDirection="row" flexGrow={isLast ? 0 : 1}>
        {beneath}
      </Box>
    </Box>
  )
}
