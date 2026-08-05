import type { Conversation, Message } from './types'

/**
 * Phase 1 stand-in for the database. Phase 3 replaces these two exports with
 * fetches against `/api/conversations`; nothing else in the UI should need to change.
 *
 * One conversation deliberately carries a `thinking` block so the collapsible
 * reasoning panel can be laid out and verified before Phase 2 wires it for real.
 */

export const mockConversations: Conversation[] = [
  {
    id: 'c1',
    title: 'Explaining hash maps',
    tier: 'high',
    createdAt: '2026-08-05T00:41:00Z',
    updatedAt: '2026-08-05T00:44:00Z',
  },
  {
    id: 'c2',
    title: 'Weekend trip packing list',
    tier: 'low',
    createdAt: '2026-08-04T18:12:00Z',
    updatedAt: '2026-08-04T18:20:00Z',
  },
  {
    id: 'c3',
    title: 'Rewriting a cover letter',
    tier: 'medium',
    createdAt: '2026-08-03T09:05:00Z',
    updatedAt: '2026-08-03T09:31:00Z',
  },
  {
    id: 'c4',
    title: 'Why is my laptop fan loud?',
    tier: 'medium',
    createdAt: '2026-08-01T21:47:00Z',
    updatedAt: '2026-08-01T21:52:00Z',
  },
]

export const mockMessages: Record<string, Message[]> = {
  c1: [
    {
      id: 'm1',
      conversationId: 'c1',
      role: 'user',
      content: 'In one sentence, what is a hash map?',
      createdAt: '2026-08-05T00:41:00Z',
    },
    {
      id: 'm2',
      conversationId: 'c1',
      role: 'assistant',
      model: 'qwen3:4b',
      thinking:
        'The user wants a one-sentence definition, so brevity matters more than completeness. ' +
        'The essential ideas are key-value storage and the hash function computing an index. ' +
        'I should mention average constant-time lookup since that is the whole point of the ' +
        'structure, but I must not let the sentence sprawl into a paragraph.',
      content:
        'A hash map is a data structure that stores key-value pairs and uses a hash function ' +
        'to compute an index for each key, giving average constant-time lookups, insertions ' +
        'and deletions.',
      createdAt: '2026-08-05T00:42:00Z',
    },
    {
      id: 'm3',
      conversationId: 'c1',
      role: 'user',
      content: 'What happens when two keys collide?',
      createdAt: '2026-08-05T00:43:00Z',
    },
    {
      id: 'm4',
      conversationId: 'c1',
      role: 'assistant',
      model: 'qwen3:4b',
      thinking:
        'Two standard strategies: separate chaining and open addressing. Worth naming both ' +
        'and describing them in one line each rather than going deep on probe sequences.',
      content:
        "There are two common strategies. **Separate chaining** stores colliding entries in a " +
        'list at the same bucket, so lookups walk a short chain. **Open addressing** instead ' +
        'probes for the next free slot in the array itself.\n\nBoth degrade toward linear time ' +
        'as the table fills, which is why implementations resize once the load factor crosses ' +
        'a threshold.',
      createdAt: '2026-08-05T00:44:00Z',
    },
  ],
  c2: [
    {
      id: 'm5',
      conversationId: 'c2',
      role: 'user',
      content: 'Packing list for two nights in the mountains, cold weather.',
      createdAt: '2026-08-04T18:12:00Z',
    },
    {
      id: 'm6',
      conversationId: 'c2',
      role: 'assistant',
      model: 'qwen2.5:1.5b',
      content:
        'Here is a compact list:\n\n- Insulated jacket and a fleece mid-layer\n' +
        '- Thermal base layers, two sets\n- Waterproof outer shell\n- Wool socks, three pairs\n' +
        '- Gloves, beanie, neck gaiter\n- Head torch and spare batteries\n' +
        '- Water bottle and a thermos\n\nPack the spare socks somewhere dry and separate — ' +
        'they are the one thing you will regret losing.',
      createdAt: '2026-08-04T18:20:00Z',
    },
  ],
  c3: [
    {
      id: 'm7',
      conversationId: 'c3',
      role: 'user',
      content: 'Make this opening line less stiff: "I am writing to express my interest in the position."',
      createdAt: '2026-08-03T09:05:00Z',
    },
    {
      id: 'm8',
      conversationId: 'c3',
      role: 'assistant',
      model: 'llama3.2:3b',
      content:
        'A few options, warmest last:\n\n1. "I would like to apply for the position."\n' +
        '2. "I am applying for the role because it lines up closely with what I have been building."\n' +
        '3. "This role caught my attention immediately — it is the work I have spent the last ' +
        'three years doing."\n\nThe third commits to a claim, which is what makes it read as ' +
        'human rather than templated.',
      createdAt: '2026-08-03T09:31:00Z',
    },
  ],
  c4: [
    {
      id: 'm9',
      conversationId: 'c4',
      role: 'user',
      content: 'My laptop fan gets loud whenever I run anything heavy. Is that bad?',
      createdAt: '2026-08-01T21:47:00Z',
    },
    {
      id: 'm10',
      conversationId: 'c4',
      role: 'assistant',
      model: 'llama3.2:3b',
      content:
        'Usually not — a loud fan means the cooling system is doing its job. It is worth ' +
        'investigating if the noise comes with throttling, sudden shutdowns, or a chassis too ' +
        'hot to rest your hands on.\n\nThe most common fixable cause is dust in the heatsink ' +
        'fins, followed by dried-out thermal paste on machines more than a few years old.',
      createdAt: '2026-08-01T21:52:00Z',
    },
  ],
}
