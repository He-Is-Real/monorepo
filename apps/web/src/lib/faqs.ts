import type { FaqItem } from '@/components/faq/faq-accordion';

// The FAQs (faqs.html's copy). Changed where the mockup disagrees with what we've built or
// decided: anonymous stories show "Anonymous" (story-view), and sharing on social media is
// its own consent (`share_socials`, gdpr-consent.md), never implied by submitting, and chosen per
// story (O4).

export interface FaqGroup {
  id: string;
  heading: string;
  items: FaqItem[];
}

export const FAQ_GROUPS: FaqGroup[] = [
  {
    id: 'sharing',
    heading: 'Sharing your story',
    items: [
      {
        id: 'what-kind',
        question: 'What kind of stories can I submit?',
        answer:
          'Personal experiences with God: healing, divine encounters, answered prayers, transformation, or any moment where you encountered something beyond yourself. It doesn’t have to be dramatic; it just needs to be real.',
      },
      {
        id: 'anonymous',
        question: 'Can I submit anonymously?',
        answer:
          'Yes. You’ll need an account with a verified email address, but you can choose not to show your name. Your story then appears as “Anonymous”.',
      },
      {
        id: 'formats',
        question: 'What formats can I use?',
        answer:
          'A video recording, an audio recording, or a written story. You can also combine formats.',
      },
      {
        id: 'after-submit',
        question: 'What happens after I submit?',
        answer:
          'Our team reviews every story before it’s published. We’ll let you know when it’s approved or if we have feedback, and you can check its status from your profile any time.',
      },
      {
        id: 'where-shared',
        question: 'Where will my story appear?',
        answer:
          'Approved stories appear on this website. We’d also love to share some on our social media channels and YouTube, but only if you say yes. That’s a separate choice for each story, made when you submit it, and it can’t be changed afterwards. Deleting your account withdraws it: we make no new use of your stories, though copies already shared can’t be recalled.',
      },
      {
        id: 'edit-remove',
        question: 'Can I edit or remove my story?',
        answer:
          'Yes. You can edit the details or withdraw your story at any time from your profile page.',
      },
    ],
  },
  {
    id: 'about',
    heading: 'About He Is Real',
    items: [
      {
        id: 'church',
        question: 'Is He Is Real a church?',
        answer:
          'No. He Is Real Today is a not-for-profit organisation, not a church. We are not affiliated with any particular Christian denomination.',
      },
      {
        id: 'charity',
        question: 'Is it a charity?',
        answer:
          'We have applied for charitable status in England and Wales. We operate as a UK-based not-for-profit.',
      },
      {
        id: 'data',
        question: 'How is my data protected?',
        answer:
          'We follow UK data protection law. Your email address is never shown publicly, your story is only published with your explicit consent, and you can withdraw it at any time. Our privacy notice has the details.',
      },
    ],
  },
  {
    id: 'bigger',
    heading: 'Bigger questions',
    items: [
      {
        id: 'doubts',
        question: 'Can someone believe in God and still have doubts?',
        answer:
          'Absolutely. Doubt is a natural part of any honest spiritual journey. Many stories on this site come from people who have wrestled with doubt, and found something real on the other side.',
      },
      {
        id: 'proof',
        question: 'What proof is there that God exists?',
        answer:
          'That’s the question at the heart of this site. Rather than arguments or theology, we offer something different: real stories from real people. Browse them and decide for yourself.',
      },
    ],
  },
];

/** schema.org FAQPage, from the same copy the page shows. */
export function faqPageJsonLd(groups: FaqGroup[] = FAQ_GROUPS): object {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: groups.flatMap((g) =>
      g.items.map((i) => ({
        '@type': 'Question',
        name: i.question,
        acceptedAnswer: { '@type': 'Answer', text: i.answer },
      })),
    ),
  };
}
