import React from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { NameEditor } from './CreateMacroApp';

afterEach(cleanup);

describe('Create Macro NameEditor draft synchronization', () => {
  it('updates parent validation state while keeping dotted typing flat until blur', () => {
    function Harness(): React.ReactElement {
      const [value, setValue] = React.useState('');
      return (
        <>
          <NameEditor value={value} macroCandidates={[]} onChange={setValue} />
          <output aria-label="Parent macro name">{value}</output>
        </>
      );
    }

    const view = render(<Harness />);
    const input = view.getByRole('textbox') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Foo.bar' } });
    expect(view.getByRole('status', { name: 'Parent macro name' }).textContent).toBe('Foo.bar');
    expect(view.getAllByRole('textbox')).toHaveLength(1);

    fireEvent.blur(input);
    expect(view.getAllByRole('textbox')).toHaveLength(2);
  });
});
