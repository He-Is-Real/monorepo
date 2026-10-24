import { playerSrc } from './story-media';

const PLAYER =
  'https://player.mediadelivery.net/embed/786537/b8a77258-abfd-469d-ba63-9b89b62fcce6?token=abc&expires=1792789200';

describe('playerSrc', () => {
  it('keeps the signature and turns autoplay and preload off', () => {
    const src = new URL(playerSrc(PLAYER)!);
    expect(src.searchParams.get('token')).toBe('abc');
    expect(src.searchParams.get('expires')).toBe('1792789200');
    expect(src.searchParams.get('autoplay')).toBe('false');
    expect(src.searchParams.get('preload')).toBe('false');
  });

  it('overrides an autoplay the URL already asks for', () => {
    expect(
      new URL(playerSrc(`${PLAYER}&autoplay=true`)!).searchParams.getAll(
        'autoplay',
      ),
    ).toEqual(['false']);
  });

  it.each(['javascript:alert(1)', 'not a url', 'data:text/html,hi'])(
    'refuses %p',
    (url) => {
      expect(playerSrc(url)).toBeNull();
    },
  );
});
