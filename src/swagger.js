export const swaggerDocument = {
  openapi: '3.0.0',
  info: {
    title: 'Qurated Backend API',
    version: '1.0.0',
    description: 'API documentation for the Qurated supplier ingestion and source management system.',
  },
  servers: [
    {
      url: '/api',
      description: 'Local development server',
    },
  ],
  components: {
    parameters: {
      MerchantIdHeader: {
        in: 'header',
        name: 'x-merchant-id',
        required: true,
        schema: { type: 'string', format: 'uuid', default: '00000000-0000-0000-0000-000000000001' },
        description: 'Tenant isolation identifier',
      },
    },
    schemas: {
      Source: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          merchant_id: { type: 'string' },
          name: { type: 'string' },
          type: { type: 'string' },
          default_model_id: { type: 'string' },
          connection_config: { type: 'object' },
          schedule_cron: { type: 'string', nullable: true },
          status: { type: 'string' },
          created_at: { type: 'string', format: 'date-time' },
          last_run_at: { type: 'string', format: 'date-time', nullable: true },
        },
      },
      IngestionRun: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          source_id: { type: 'string', format: 'uuid' },
          merchant_id: { type: 'string' },
          status: { type: 'string', enum: ['PROCESSING', 'COMPLETED', 'FAILED'] },
          started_at: { type: 'string', format: 'date-time' },
          finished_at: { type: 'string', format: 'date-time', nullable: true },
          total_rows: { type: 'integer' },
          valid_rows: { type: 'integer' },
          failed_rows: { type: 'integer' },
          error_message: { type: 'string', nullable: true },
        },
      },
      ProductModelAttribute: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          model_id: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          data_type: { type: 'string', enum: ['string', 'number', 'boolean', 'enum'] },
          is_required: { type: 'boolean', default: false },
          list_of_values: { type: 'array', items: { type: 'string' } },
        },
      },
      ProductModel: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          merchant_id: { type: 'string', format: 'uuid', nullable: true },
          name: { type: 'string' },
          description: { type: 'string', nullable: true },
          status: { type: 'string', enum: ['ACTIVE', 'ARCHIVED'] },
          schema_version: { type: 'integer', default: 1 },
          created_by: { type: 'string' },
          updated_by: { type: 'string' },
          created_at: { type: 'string', format: 'date-time' },
          updated_at: { type: 'string', format: 'date-time' },
          attributes: {
            type: 'array',
            items: { $ref: '#/components/schemas/ProductModelAttribute' },
          },
        },
      },
    },
  },
  paths: {
    '/sources': {
      get: {
        summary: 'List all sources',
        tags: ['Sources'],
        parameters: [{ $ref: '#/components/parameters/MerchantIdHeader' }],
        responses: {
          200: { description: 'A list of sources' },
        },
      },
      post: {
        summary: 'Create a new source',
        tags: ['Sources'],
        parameters: [{ $ref: '#/components/parameters/MerchantIdHeader' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name', 'type', 'default_model_id'],
                properties: {
                  name: { type: 'string', example: 'HVH Local Sample Feed' },
                  type: { type: 'string', example: 'xml' },
                  default_model_id: { type: 'string', example: 'google/gemini-flash-1.5' },
                  connection_config: { type: 'object', properties: { url: { type: 'string', example: 'sample-feed.xml' } } },
                  schedule_cron: { type: 'string', example: '0 2 * * *' },
                },
                example: {
                  name: 'HVH Local Sample Feed',
                  type: 'csv',
                  default_model_id: 'google/gemini-flash-1.5',
                  connection_config: { url: 'https://example.com/feed.csv' },
                  schedule_cron: '0 2 * * *',
                  status: 'ACTIVE'
                }
              },
            },
          },
        },
        responses: {
          201: { description: 'Source created successfully' },
        },
      },
    },
    '/sources/{id}': {
      get: {
        summary: 'Get a specific source',
        tags: ['Sources'],
        parameters: [
          { $ref: '#/components/parameters/MerchantIdHeader' },
          { in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        responses: {
          200: { description: 'Source details' },
        },
      },
      put: {
        summary: 'Update a specific source',
        tags: ['Sources'],
        parameters: [
          { $ref: '#/components/parameters/MerchantIdHeader' },
          { in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  type: { type: 'string', enum: ['csv', 'xml', 'api'] },
                  default_model_id: { type: 'string' },
                  connection_config: { type: 'object' },
                  schedule_cron: { type: 'string', nullable: true },
                  status: { type: 'string', enum: ['ACTIVE', 'PAUSED', 'ARCHIVED'] },
                },
                example: {
                  name: 'Updated HVH Feed',
                  type: 'xml',
                  default_model_id: 'google/gemini-flash-1.5',
                  connection_config: { url: 'https://example.com/feed.xml' },
                  schedule_cron: '0 2 * * *',
                  status: 'ACTIVE'
                }
              },
            },
          },
        },
        responses: {
          200: { description: 'Source updated successfully' },
          400: { description: 'Validation error' },
          404: { description: 'Source not found' },
        },
      },
      delete: {
        summary: 'Delete a specific source',
        tags: ['Sources'],
        parameters: [
          { $ref: '#/components/parameters/MerchantIdHeader' },
          { in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        responses: {
          200: { description: 'Source deleted' },
        },
      },
    },
    '/sources/{id}/sync': {
      post: {
        summary: 'Trigger manual source sync',
        tags: ['Ingestion'],
        parameters: [
          { $ref: '#/components/parameters/MerchantIdHeader' },
          { in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        responses: {
          202: { description: 'Ingestion started in the background' },
          409: { description: 'Sync already in progress' },
        },
      },
    },
    '/sources/{id}/runs': {
      get: {
        summary: 'List all ingestion runs for a source',
        tags: ['Ingestion'],
        parameters: [
          { $ref: '#/components/parameters/MerchantIdHeader' },
          { in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        responses: {
          200: { description: 'List of runs' },
        },
      },
    },
    '/sources/runs/{runId}': {
      get: {
        summary: 'Fetch specific run status',
        tags: ['Ingestion'],
        parameters: [
          { $ref: '#/components/parameters/MerchantIdHeader' },
          { in: 'path', name: 'runId', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        responses: {
          200: { description: 'Run details' },
        },
      },
    },
    '/extract': {
      post: {
        summary: 'Test AI extraction (Mock)',
        tags: ['Utility & Testing'],
        responses: { 200: { description: 'Mock extraction result' } }
      }
    },
    '/ingest-csv': {
      post: {
        summary: 'Test CSV Parsing',
        tags: ['Utility & Testing'],
        requestBody: {
          content: {
            'application/json': { schema: { type: 'object', properties: { filePath: { type: 'string' } } } }
          }
        },
        responses: { 200: { description: 'CSV parsing summary' } }
      }
    },
    '/lineage/{documentId}': {
      get: {
        summary: 'Get AI extraction lineage',
        tags: ['Utility & Testing'],
        parameters: [{ in: 'path', name: 'documentId', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Lineage data' } }
      }
    },
    '/models': {
      get: {
        summary: 'List product models available to merchant (including global templates)',
        tags: ['Models'],
        parameters: [{ $ref: '#/components/parameters/MerchantIdHeader' }],
        responses: { 200: { description: 'List of models' } }
      },
      post: {
        summary: 'Create a new product model',
        tags: ['Models'],
        parameters: [{ $ref: '#/components/parameters/MerchantIdHeader' }],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name'],
                properties: {
                  name: { type: 'string', minLength: 3, maxLength: 255 },
                  description: { type: 'string', nullable: true },
                  attributes: {
                    type: 'array',
                    items: {
                      type: 'object',
                      required: ['name', 'data_type'],
                      properties: {
                        name: { type: 'string' },
                        data_type: { type: 'string', enum: ['string', 'number', 'boolean', 'enum'] },
                        is_required: { type: 'boolean', default: false },
                        list_of_values: { type: 'array', items: { type: 'string' } }
                      }
                    }
                  }
                }
              }
            }
          }
        },
        responses: { 201: { description: 'Created model' }, 400: { description: 'Validation error' } }
      }
    },
    '/models/{id}': {
      get: {
        summary: 'Get product model by ID',
        tags: ['Models'],
        parameters: [
          { $ref: '#/components/parameters/MerchantIdHeader' },
          { in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }
        ],
        responses: { 200: { description: 'Product model details' }, 403: { description: 'Forbidden' }, 404: { description: 'Not found' } }
      },
      put: {
        summary: 'Update an existing product model',
        tags: ['Models'],
        parameters: [
          { $ref: '#/components/parameters/MerchantIdHeader' },
          { in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }
        ],
        responses: { 200: { description: 'Updated model' }, 403: { description: 'Forbidden: Global template or other merchant' }, 404: { description: 'Not found' } }
      },
      delete: {
        summary: 'Soft-delete a product model (status = ARCHIVED)',
        tags: ['Models'],
        parameters: [
          { $ref: '#/components/parameters/MerchantIdHeader' },
          { in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }
        ],
        responses: { 200: { description: 'Model archived' }, 403: { description: 'Forbidden: Global template or other merchant' }, 404: { description: 'Not found' } }
      }
    },
    '/models/{templateId}/clone': {
      post: {
        summary: 'Clone a global template or existing model into merchant namespace',
        tags: ['Models'],
        parameters: [
          { $ref: '#/components/parameters/MerchantIdHeader' },
          { in: 'path', name: 'templateId', required: true, schema: { type: 'string', format: 'uuid' } }
        ],
        responses: { 201: { description: 'Cloned model' }, 403: { description: 'Forbidden' }, 404: { description: 'Not found' } }
      }
    }
  },
};