import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import App from './App.svelte';

describe('App', () => {
  it('identifies the product and its empty state', () => {
    render(App);
    expect(screen.getByRole('heading', { name: 'Lightscribe' })).toBeInTheDocument();
    expect(screen.getByText('Open an MP3 or WAV file to begin.')).toBeInTheDocument();
  });
});
