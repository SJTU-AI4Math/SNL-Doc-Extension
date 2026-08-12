import React from 'react';

export type IconName =
  | 'add'
  | 'add-parent'
  | 'add-child'
  | 'add-sibling'
  | 'remove'
  | 'delete'
  | 'open'
  | 'refresh'
  | 'move-up'
  | 'move-down'
  | 'indent'
  | 'outdent'
  | 'chevron-right'
  | 'chevron-left'
  | 'chevron-down'
  | 'close'
  | 'copy'
  | 'edit'
  | 'book'
  | 'search';

export function Icon({
  name,
  size = 16,
  className
}: {
  name: IconName;
  size?: number;
  className?: string;
}): React.ReactElement {
  return (
    <svg
      data-snl-icon={name}
      className={['snl-icon', className].filter(Boolean).join(' ')}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {paths[name]}
    </svg>
  );
}

const paths: Record<IconName, React.ReactNode> = {
  add: <><path d="M8 3v10M3 8h10" /></>,
  'add-parent': <><path d="M8 2v8h5M5 5h6" /></>,
  'add-child': <><path d="M4 4v6h10M11 7v6" /></>,
  'add-sibling': <><path d="M3 4h10" /><path d="M8 7v6M5 10h6" /></>,
  remove: <><path d="M3 8h10" /></>,
  delete: <><path d="M3.5 5h9M6 5V3.5h4V5m1 0-.5 8h-5L5 5M7 7v4M9 7v4" /></>,
  open: <><path d="M6 4H3.5v8.5H12V10M8.5 3.5h4v4M12.5 3.5 7 9" /></>,
  refresh: <><path d="M12.5 6A5 5 0 1 0 13 9M12.5 2.5V6h-3.5" /></>,
  'move-up': <><path d="M8 13V3M4.5 6.5 8 3l3.5 3.5" /></>,
  'move-down': <><path d="M8 3v10M4.5 9.5 8 13l3.5-3.5" /></>,
  indent: <><path d="M3 3v10M5.5 8h7M10 5.5 12.5 8 10 10.5" /></>,
  outdent: <><path d="M3 3v10M12.5 8h-7M8 5.5 5.5 8 8 10.5" /></>,
  'chevron-right': <><path d="m6 3.5 4.5 4.5L6 12.5" /></>,
  'chevron-left': <><path d="m10 3.5-4.5 4.5 4.5 4.5" /></>,
  'chevron-down': <><path d="m3.5 6 4.5 4.5L12.5 6" /></>,
  close: <><path d="m4 4 8 8M12 4l-8 8" /></>,
  copy: <><rect x="5.5" y="5.5" width="7" height="7" rx="1" /><path d="M10.5 5.5v-2h-7v7h2" /></>,
  edit: <><path d="m3.5 12.5 2.7-.6 6-6-2.1-2.1-6 6-.6 2.7ZM9.5 4.5l2 2" /></>,
  book: <><path d="M2.5 3.5c2.1-.7 3.8-.4 5.5.8v8c-1.7-1.2-3.4-1.5-5.5-.8v-8ZM13.5 3.5c-2.1-.7-3.8-.4-5.5.8v8c1.7-1.2 3.4-1.5 5.5-.8v-8Z" /></>,
  search: <><circle cx="7" cy="7" r="4" /><path d="m10 10 3 3" /></>
};
