import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Alert, EmptyState, FormField, Select, TextArea, TextInput } from './FormControls';

describe('shared form and feedback controls', () => {
  it('wires labels, hints, errors and invalid state', () => {
    const html = renderToStaticMarkup(
      <FormField id="name" label="Name" hint="Choose carefully" error="Required">
        <TextInput value="" readOnly />
      </FormField>
    );
    expect(html).toContain('for="name"');
    expect(html).toContain('id="name"');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('aria-describedby="name-hint name-error"');
  });

  it('gives all controls the same themed base class', () => {
    expect(renderToStaticMarkup(<TextInput />)).toContain('snl-control');
    expect(renderToStaticMarkup(<Select><option>x</option></Select>)).toContain('snl-control');
    expect(renderToStaticMarkup(<TextArea />)).toContain('snl-control');
  });

  it('maps alert severity to live-region semantics', () => {
    expect(renderToStaticMarkup(<Alert severity="error">bad</Alert>)).toContain('role="alert"');
    expect(renderToStaticMarkup(<Alert severity="warning">careful</Alert>)).toContain('role="status"');
  });

  it('renders an empty state with an optional action', () => {
    const html = renderToStaticMarkup(
      <EmptyState title="Nothing here" description="Create one" action={<button>add</button>} />
    );
    expect(html).toContain('Nothing here');
    expect(html).toContain('add');
  });
});
