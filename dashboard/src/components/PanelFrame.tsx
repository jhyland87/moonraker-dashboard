import { Text } from 'react-curse';

/**
 * Props for {@link PanelFrame}.
 * @source
 */
export interface PanelFrameProps {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Title rendered inline in the top border row. */
  readonly title?: string;
  /** Optional right-aligned text in the top border (status indicators, etc.). */
  readonly rightLabel?: string;
  /** Color of the box-drawing characters. Defaults to BrightBlack. */
  readonly accent?: string;
  /** Color of the title text. Defaults to White + bold. */
  readonly titleColor?: string;
  /** Color of the right-side label. Defaults to BrightBlack. */
  readonly rightLabelColor?: string;
}

/**
 * Single-cell border drawing component. Renders box-drawing characters
 * around the rectangle `(x, y) → (x + width - 1, y + height - 1)`. The
 * interior is left untouched — callers render their own content inset by
 * one cell on each side (i.e. at `x + 1`, `y + 1`, `width - 2`, `height - 2`).
 *
 * Side bars are emitted as single-cell `<Text>` elements (one at the left
 * edge, one at the right edge of each interior row) so that block-fill
 * content inside the frame doesn't clobber them. Render order matters:
 * place `<PanelFrame>` *before* the content so the content sits on top of
 * the (empty) interior of the frame.
 *
 * @param props - See {@link PanelFrameProps}.
 * @returns The border element.
 *
 * @example
 * ```tsx
 * <PanelFrame x={0} y={0} width={40} height={6} title="Sensors" />
 * <SensorContent x={1} y={1} width={38} height={4} … />
 * ```
 * @source
 */
export const PanelFrame = ({
  x,
  y,
  width,
  height,
  title,
  rightLabel,
  accent = 'BrightBlack',
  titleColor = 'White',
  rightLabelColor = 'BrightBlack',
}: PanelFrameProps) => {
  if (width < 2 || height < 2) return null;

  const inner = width - 2;
  // Top: "┌─ title ──────... rightLabel ─┐"
  // Layout the title segment first, then fill the gap to the right label
  // (if any), then the right label, all with `─` padding around them.
  const titleSegment = title ? ` ${title} ` : '';
  const rightSegment = rightLabel ? ` ${rightLabel} ` : '';
  // Available `─` runs: between left corner and title, between title and
  // right label, between right label and right corner.
  const usable = inner - titleSegment.length - rightSegment.length;
  const dashLeft = title ? 1 : Math.max(0, usable);
  const dashRight = rightLabel ? 1 : 0;
  const dashMid = Math.max(0, usable - dashLeft - dashRight);
  const topLine =
    '─'.repeat(Math.max(0, dashLeft)) +
    titleSegment +
    '─'.repeat(dashMid) +
    rightSegment +
    '─'.repeat(dashRight);

  const bottomLine = '─'.repeat(inner);

  // Build the side rows as an array up front so the JSX stays readable.
  const sideRows: number[] = [];
  for (let i = 1; i < height - 1; i++) sideRows.push(i);

  return (
    <>
      {/* Top border row — corners + dashes, with the title segment inline
          in its natural color (overlaid on the `─` run). */}
      <Text x={x} y={y} width={width} height={1} block>
        <Text x={0} color={accent}>
          ┌
        </Text>
        <Text x={1} color={accent}>
          {topLine}
        </Text>
        <Text x={width - 1} color={accent}>
          ┐
        </Text>
        {title && (
          <Text x={1 + dashLeft + 1} color={titleColor} bold>
            {title}
          </Text>
        )}
        {rightLabel && (
          <Text x={1 + dashLeft + titleSegment.length + dashMid + 1} color={rightLabelColor}>
            {rightLabel}
          </Text>
        )}
      </Text>

      {/* Side bars — two single-cell glyphs per interior row so we don't
          paint over content rendered inside the frame. */}
      {sideRows.map((i) => (
        <Text key={`pf-l${i}`} x={x} y={y + i} color={accent}>
          │
        </Text>
      ))}
      {sideRows.map((i) => (
        <Text key={`pf-r${i}`} x={x + width - 1} y={y + i} color={accent}>
          │
        </Text>
      ))}

      {/* Bottom border row. */}
      <Text x={x} y={y + height - 1} width={width} height={1} block>
        <Text x={0} color={accent}>
          └
        </Text>
        <Text x={1} color={accent}>
          {bottomLine}
        </Text>
        <Text x={width - 1} color={accent}>
          ┘
        </Text>
      </Text>
    </>
  );
};
