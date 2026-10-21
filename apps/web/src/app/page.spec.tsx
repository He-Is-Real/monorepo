/**
 * @jest-environment node
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Page from './page';
import { getPublicStory, StoriesUnavailableError } from '@/lib/public-stories';

jest.mock('next/server', () => ({
  connection: jest.fn(async () => undefined),
}));
jest.mock('@/components/logo', () => ({ Logo: () => <span>logo</span> }));
jest.mock('@/lib/public-stories', () => {
  const actual = jest.requireActual('@/lib/public-stories');
  return { ...actual, getPublicStory: jest.fn() };
});
const mockGet = getPublicStory as jest.Mock;

const story = {
  id: 'dev_seed',
  slug: 'test-story',
  title: 'Test story: the walking skeleton',
  description: 'Placeholder content.',
  body: 'First paragraph.\n\nSecond paragraph.',
  bylineName: 'Test Person',
  primaryFormat: 'written',
  tags: [],
  publishedAt: '2026-10-21T20:00:00Z',
  version: 1,
};

describe('Home page', () => {
  const saved = process.env['FEATURED_STORY_SLUG'];
  afterEach(() => {
    jest.resetAllMocks();
    if (saved === undefined) delete process.env['FEATURED_STORY_SLUG'];
    else process.env['FEATURED_STORY_SLUG'] = saved;
  });

  it('renders the featured story on the server, with a link to its page', async () => {
    process.env['FEATURED_STORY_SLUG'] = 'test-story';
    mockGet.mockResolvedValue({ kind: 'story', story });
    const html = renderToStaticMarkup(await Page());
    expect(mockGet).toHaveBeenCalledWith('test-story');
    expect(html).toContain('<main id="main"');
    expect(html).toContain('<h1');
    expect(html).toContain('Test story: the walking skeleton</h2>');
    expect(html).toContain('<p>First paragraph.</p><p>Second paragraph.</p>');
    expect(html).toContain('href="/stories/test-story"');
    expect(html).toContain('Test Person');
  });

  it('shows a friendly message when api-public-read is down', async () => {
    process.env['FEATURED_STORY_SLUG'] = 'test-story';
    mockGet.mockRejectedValue(new StoriesUnavailableError('status 503'));
    const html = renderToStaticMarkup(await Page());
    expect(html).toContain('role="status"');
    expect(html).toContain('Stories can’t be loaded right now');
  });

  it('shows only the welcome without a featured story', async () => {
    delete process.env['FEATURED_STORY_SLUG'];
    const html = renderToStaticMarkup(await Page());
    expect(mockGet).not.toHaveBeenCalled();
    expect(html).toContain('He Is Real Today</h1>');
    expect(html).not.toContain('Featured story');
  });
});
