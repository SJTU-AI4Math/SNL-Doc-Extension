import React from 'react';

export type IconName =
  | 'add'
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
  'add-child': <><path d="M3 3.5h4M5 2v3M5 5.5v5h3M8 8.5v4M6 10.5h4" /></>,
  'add-sibling': <><path d="M3 4h4M5 2v4M9 10h4M11 8v4M5 6v4h4" /></>,
  remove: <><path d="M3 8h10" /></>,
  delete: <><path d="M3.5 5h9M6 5V3.5h4V5m1 0-.5 8h-5L5 5M7 7v4M9 7v4" /></>,
  open: <><path d="M6 4H3.5v8.5H12V10M8.5 3.5h4v4M12.5 3.5 7 9" /></>,
  refresh: <><path d="M12.5 6A5 5 0 1 0 13 9M12.5 2.5V6h-3.5" /></>,
  'move-up': <><path d="M8 13V3M4.5 6.5 8 3l3.5 3.5" /></>,
  'move-down': <><path d="M8 3v10M4.5 9.5 8 13l3.5-3.5" /></>,
  indent: <><path d="M2.5 3.5h11M7 7h6.5M7 10.5h6.5M2.5 8h3M4 6.5 5.5 8 4 9.5" /></>,
  outdent: <><path d="M2.5 3.5h11M7 7h6.5M7 10.5h6.5M5.5 8h-3M4 6.5 2.5 8 4 9.5" /></>,
  'chevron-right': <><path d="m6 3.5 4.5 4.5L6 12.5" /></>,
  'chevron-left': <><path d="m10 3.5-4.5 4.5 4.5 4.5" /></>,
  'chevron-down': <><path d="m3.5 6 4.5 4.5L12.5 6" /></>,
  close: <><path d="m4 4 8 8M12 4l-8 8" /></>,
  copy: <><rect x="5.5" y="5.5" width="7" height="7" rx="1" /><path d="M10.5 5.5v-2h-7v7h2" /></>,
  edit: <><path d="m3.5 12.5 2.7-.6 6-6-2.1-2.1-6 6-.6 2.7ZM9.5 4.5l2 2" /></>,
  search: <><circle cx="7" cy="7" r="4" /><path d="m10 10 3 3" /></>
};
