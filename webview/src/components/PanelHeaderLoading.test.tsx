// @vitest-environment jsdom
import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CreateRelationshipApp } from '../CreateRelationshipApp';
import { ExportOptionsApp } from '../ExportOptionsApp';
import { SnlGraphApp } from '../SnlGraphApp';

afterEach(cleanup);

describe('PanelHeader loading-state coverage', () => {
  it.each([
    ['Create Relationship', <CreateRelationshipApp />],
    ['Export HTML', <ExportOptionsApp />],
    ['SNL Relationship Graph', <SnlGraphApp />]
  ])('keeps branding, language selection and title visible while %s loads', (title, app) => {
    document.documentElement.lang = 'en';
    document.documentElement.dataset.snlLanguagePreference = 'en';
    const view = render(app);

    expect(view.getByRole('heading', { name: title })).toBeTruthy();
    expect(view.getByText('SJTU AI4Math')).toBeTruthy();
    expect(view.getByRole('button', { name: /Interface language/ })).toBeTruthy();
  });
});
