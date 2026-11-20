// @file / @symbol completion popup with keyboard navigation.

const MENTION_TAIL = /(?:^|\s)@(file|symbol)\s+([^\s@]*)$/;

export interface Completion {
  /** Returns true when the key was consumed by the popup. */
  onKeydown: (event: KeyboardEvent) => boolean;
  show: (items: string[]) => void;
  hide: () => void;
}

export function createCompletion(
  promptBox: HTMLTextAreaElement,
  popup: HTMLElement,
  query: (kind: string, text: string) => void,
): Completion {
  let active = -1;
  const options = (): HTMLElement[] => Array.from(popup.children) as HTMLElement[];
  const isOpen = (): boolean => popup.style.display === 'block';

  function hide(): void {
    popup.style.display = 'none';
    active = -1;
  }

  function highlight(index: number): void {
    const items = options();
    active = (index + items.length) % items.length;
    items.forEach((item, i) => item.classList.toggle('active', i === active));
    items[active]?.scrollIntoView({ block: 'nearest' });
  }

  function pick(value: string): void {
    // Symbols arrive as "name (path:line)"; insert just the name.
    const insert = value.replace(/\s+\(.*\)$/, '');
    promptBox.value = promptBox.value.replace(/(^|\s)@(file|symbol)\s+[^\s@]*$/, `$1@$2 ${insert} `);
    hide();
    promptBox.focus();
  }

  function show(items: string[]): void {
    popup.textContent = '';
    if (items.length === 0 || !MENTION_TAIL.test(promptBox.value)) {
      hide();
      return;
    }
    for (const item of items) {
      const option = document.createElement('div');
      option.textContent = item;
      option.addEventListener('mousedown', (event) => {
        event.preventDefault();
        pick(item);
      });
      popup.appendChild(option);
    }
    popup.style.display = 'block';
    highlight(0);
  }

  promptBox.addEventListener('input', () => {
    const match = MENTION_TAIL.exec(promptBox.value);
    if (match) {
      query(match[1], match[2]);
    } else {
      hide();
    }
  });
  promptBox.addEventListener('blur', () => setTimeout(hide, 100));

  return {
    show,
    hide,
    onKeydown(event) {
      if (!isOpen()) {
        return false;
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        highlight(active + (event.key === 'ArrowDown' ? 1 : -1));
      } else if (event.key === 'Enter' || event.key === 'Tab') {
        const choice = options()[active];
        if (choice?.textContent) {
          pick(choice.textContent);
        }
      } else if (event.key === 'Escape') {
        hide();
      } else {
        return false;
      }
      event.preventDefault();
      return true;
    },
  };
}
