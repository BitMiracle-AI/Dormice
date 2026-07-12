/**
 * The Clipboard API only exists in secure contexts, and this console is
 * deliberately reachable over plain http during the pre-TLS phase — the
 * textarea trick is the one copy mechanism browsers still allow there.
 */
export function copyText(text: string): Promise<void> {
  if (navigator.clipboard) {
    return navigator.clipboard.writeText(text);
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  return copied ? Promise.resolve() : Promise.reject(new Error('copy failed'));
}
