export function buildOpenApiSpec(baseUrl = ''): any {
  const servers = baseUrl ? [{ url: baseUrl }] : [{ url: '/' }];
  return {
    openapi: '3.0.3',
    info: {
      title: 'The CryptoPunks Indexer API',
      version: '1.0.0',
      description: 'REST API for owners, market, and event history (unified and normalized), with cursor pagination and filters. Realtime via WebSocket (/ws) and Server-Sent Events (/v1/stream/events).',
    },
    servers,
    components: {
      schemas: {
        Health: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            latest: { type: 'integer' },
            lastSynced: { type: 'integer' },
            behind: { type: 'integer' },
          },
        },
        Progress: {
          type: 'object',
          properties: {
            deployBlock: { type: ['integer', 'null'] },
            lastSynced: { type: ['integer', 'null'] },
            latest: { type: ['integer', 'null'] },
            behind: { type: ['integer', 'null'] },
            lastRunStartedAt: { type: ['integer', 'null'] },
            lastRunCompletedAt: { type: ['integer', 'null'] },
            lastRunProcessed: { type: ['integer', 'null'] },
          },
        },
        UnifiedEvent: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['Assign','PunkTransfer','PunkOffered','PunkNoLongerForSale','PunkBidEntered','PunkBidWithdrawn','PunkBought'] },
            punkIndex: { type: 'integer' },
            fromAddress: { type: ['string', 'null'] },
            toAddress: { type: ['string', 'null'] },
            valueWei: { type: ['string', 'null'] },
            minValueWei: { type: ['string', 'null'] },
            blockNumber: { type: 'integer' },
            blockTimestamp: { type: ['integer', 'null'] },
            txHash: { type: 'string' },
            logIndex: { type: 'integer' },
            cursor: { type: 'string', example: '12345:6' },
          },
        },
        NormalizedEvent: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['claim','transfer','list','list_cancel','bid','bid_cancel','sale'] },
            punk_id: { type: 'integer' },
            from_address: { type: ['string', 'null'] },
            to_address: { type: ['string', 'null'] },
            value_wei: { type: ['string', 'null'] },
            block_number: { type: 'integer' },
            block_timestamp: { type: ['integer', 'null'] },
            tx_hash: { type: 'string' },
            log_index: { type: 'integer' },
            cursor: { type: 'string', example: '12345:6' },
          },
        },
        EventsResponse: {
          type: 'object',
          properties: {
            events: { type: 'array', items: { $ref: '#/components/schemas/UnifiedEvent' } },
            nextCursor: { type: 'string' },
            hasMore: { type: 'boolean' },
            limit: { type: 'integer' },
            offset: { type: 'integer' },
            maxLimit: { type: 'integer' },
          },
        },
        EventsResponseNormalized: {
          type: 'object',
          properties: {
            events: { type: 'array', items: { $ref: '#/components/schemas/NormalizedEvent' } },
            nextCursor: { type: 'string' },
            hasMore: { type: 'boolean' },
            limit: { type: 'integer' },
            offset: { type: 'integer' },
            maxLimit: { type: 'integer' },
          },
        },
      },
      parameters: {
        Pagination: {
          in: 'query', name: 'limit', schema: { type: 'integer', minimum: 1 }, description: 'Items per page (1–MAX_LIMIT).', required: false,
        },
        Offset: {
          in: 'query', name: 'offset', schema: { type: 'integer', minimum: 0 }, description: 'Offset for paging.', required: false,
        },
        Cursor: {
          in: 'query', name: 'cursor', schema: { type: 'string' }, description: 'Cursor `block:log` for forward paging.', required: false,
        },
        FromCursor: {
          in: 'query', name: 'fromCursor', schema: { type: 'string' }, description: 'Alias for `cursor`.', required: false,
        },
        FromBlock: {
          in: 'query', name: 'fromBlock', schema: { type: 'integer' }, required: false,
        },
        ToBlock: { in: 'query', name: 'toBlock', schema: { type: 'integer' }, required: false },
        FromTs: { in: 'query', name: 'fromTs', schema: { type: 'integer' }, required: false },
        ToTs: { in: 'query', name: 'toTs', schema: { type: 'integer' }, required: false },
        FromDate: { in: 'query', name: 'fromDate', schema: { type: 'string' }, required: false },
        ToDate: { in: 'query', name: 'toDate', schema: { type: 'string' }, required: false },
        Types: { in: 'query', name: 'types', schema: { type: 'string' }, description: 'CSV of event types.', required: false },
        Punk: { in: 'query', name: 'punk', schema: { type: 'string' }, description: 'CSV of punk indices.', required: false },
        Address: { in: 'query', name: 'address', schema: { type: 'string' }, required: false },
      },
    },
    paths: {
      '/v1/health': { get: { summary: 'Health', responses: { 200: { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/Health' } } } } } } },
      '/v1/progress': { get: { summary: 'Progress', responses: { 200: { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/Progress' } } } } } } },
      '/v1/owners': { get: { summary: 'Owners map', responses: { 200: { description: 'OK', content: { 'application/json': { schema: { type: 'object', additionalProperties: { type: 'string' } } } } } } } },
      '/v1/owners/{address}': { get: { summary: 'Punks by owner', parameters: [{ name: 'address', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { owner: { type: 'string' }, punkIndices: { type: 'array', items: { type: 'integer' } } } } } } } } } },
      '/v1/market': { get: { summary: 'Market state', responses: { 200: { description: 'OK' } } } },
      '/v1/punks/{id}': { get: { summary: 'Punk summary', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }], responses: { 200: { description: 'OK' } } } },
      '/v1/punks/{id}/events': {
        get: {
          summary: 'Events for a punk',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
            { $ref: '#/components/parameters/Pagination' },
            { $ref: '#/components/parameters/Offset' },
            { $ref: '#/components/parameters/Cursor' },
            { $ref: '#/components/parameters/FromCursor' },
            { $ref: '#/components/parameters/FromBlock' },
            { $ref: '#/components/parameters/ToBlock' },
            { $ref: '#/components/parameters/FromTs' },
            { $ref: '#/components/parameters/ToTs' },
            { $ref: '#/components/parameters/Types' },
          ],
          responses: { 200: { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/EventsResponse' } } } } },
        },
      },
      '/v1/events': {
        get: {
          summary: 'Unified events',
          parameters: [
            { $ref: '#/components/parameters/Pagination' },
            { $ref: '#/components/parameters/Offset' },
            { $ref: '#/components/parameters/Cursor' },
            { $ref: '#/components/parameters/FromCursor' },
            { $ref: '#/components/parameters/FromBlock' },
            { $ref: '#/components/parameters/ToBlock' },
            { $ref: '#/components/parameters/FromTs' },
            { $ref: '#/components/parameters/ToTs' },
            { $ref: '#/components/parameters/Types' },
            { $ref: '#/components/parameters/Punk' },
            { $ref: '#/components/parameters/Address' },
          ],
          responses: { 200: { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/EventsResponse' } } } } },
        },
      },
      '/v1/events/normalized': {
        get: {
          summary: 'Normalized events for apps',
          parameters: [
            { $ref: '#/components/parameters/Pagination' },
            { $ref: '#/components/parameters/Offset' },
            { $ref: '#/components/parameters/Cursor' },
            { $ref: '#/components/parameters/FromCursor' },
            { $ref: '#/components/parameters/FromBlock' },
            { $ref: '#/components/parameters/ToBlock' },
            { $ref: '#/components/parameters/FromTs' },
            { $ref: '#/components/parameters/ToTs' },
            { $ref: '#/components/parameters/Types' },
            { $ref: '#/components/parameters/Punk' },
            { $ref: '#/components/parameters/Address' },
          ],
          responses: { 200: { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/EventsResponseNormalized' } } } } },
        },
      },
      '/v1/stream/events': { get: { summary: 'SSE: realtime events', responses: { 200: { description: 'text/event-stream' } } } },
    },
  };
}

