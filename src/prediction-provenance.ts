/** Older summary/side/fork sends predate generated_origin. Recognize their machine envelopes. */
export function historicalGeneratedEnvelope(text: string): boolean {
  return (
    text ===
      "Produce the catch-up summary from the supplied snapshot. Answer only; use no tools." ||
    text.startsWith("[Fork reconciliation] While ") ||
    text.startsWith("[Side prompt] While you worked,") ||
    /<\/?(?:fork_conversation|side_conversation)(?:\s|>)/.test(text)
  );
}
