import React from 'react';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { ShareMenu } from './share-menu';

describe('ShareMenu', () => {
  const writeText = jest.fn(async () => undefined);
  beforeEach(() => {
    writeText.mockClear();
    Object.assign(navigator, { clipboard: { writeText } });
    window.history.replaceState(null, '', '/stories/a-story');
  });

  const open = async () => {
    const button = screen.getByRole('button', { name: 'Share' });
    expect(button.className).toContain('min-h-11');
    await act(async () => fireEvent.click(button));
    return button;
  };

  it('offers WhatsApp, Facebook, Instagram, X and copy link, as plain links in a new tab', async () => {
    render(<ShareMenu title="A story" />);
    await open();
    expect(
      screen.getByRole('heading', { name: 'Share this story' }),
    ).toBeTruthy();
    const whatsapp = screen.getByRole('link', { name: /WhatsApp/ });
    expect(whatsapp.getAttribute('href')).toBe(
      `https://wa.me/?text=A%20story%20${encodeURIComponent('http://localhost/stories/a-story')}`,
    );
    expect(whatsapp.getAttribute('target')).toBe('_blank');
    expect(whatsapp.getAttribute('rel')).toBe('noopener noreferrer');
    expect(screen.getByRole('link', { name: /Facebook/ })).toBeTruthy();
    expect(screen.getByRole('link', { name: /^X/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Instagram/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Copy link/ })).toBeTruthy();
  });

  it('copies the page’s address, without its query', async () => {
    window.history.replaceState(null, '', '/stories/a-story?utm=x');
    render(<ShareMenu title="A story" />);
    await open();
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: /Copy link/ })),
    );
    expect(writeText).toHaveBeenCalledWith('http://localhost/stories/a-story');
    expect(screen.getByRole('status').textContent).toBe('Link copied.');
  });

  it('copies the link for Instagram, which has no share link', async () => {
    render(<ShareMenu title="A story" />);
    await open();
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: /Instagram/ })),
    );
    expect(writeText).toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toBe(
      'Link copied. Paste it in Instagram.',
    );
  });

  it('says so when copying fails', async () => {
    writeText.mockRejectedValueOnce(new Error('denied'));
    render(<ShareMenu title="A story" />);
    await open();
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: /Copy link/ })),
    );
    expect(screen.getByRole('status').textContent).toBe(
      'Couldn’t copy. Copy the address from your browser instead.',
    );
  });

  it('closes on Escape and gives focus back to the button', async () => {
    render(<ShareMenu title="A story" />);
    const button = await open();
    await act(async () =>
      fireEvent.keyDown(document.activeElement ?? document.body, {
        key: 'Escape',
      }),
    );
    expect(
      screen.queryByRole('heading', { name: 'Share this story' }),
    ).toBeNull();
    // Radix gives focus back in a timeout after the popup unmounts (FocusScope).
    await waitFor(() => expect(document.activeElement).toBe(button));
  });

  // Codex review of #66, finding 6: never taller than the room Radix measured; it scrolls.
  it('fits the screen’s height and scrolls inside when it must', async () => {
    render(<ShareMenu title="A story" />);
    await open();
    const popup = screen.getByRole('dialog');
    expect(popup.className).toContain(
      'max-h-[var(--radix-popover-content-available-height)]',
    );
    expect(popup.className).toContain('overflow-y-auto');
  });
});
