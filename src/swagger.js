export const swaggerDocument = {
  openapi: '3.0.0',
  info: {
    title: 'Qurated Backend API',
    version: '1.0.0',
    description: 'API documentation for the Qurated supplier ingestion, source management, and product data model system.',
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
          key: { type: 'string', pattern: '^[a-z0-9_]+$' },
          data_type: { type: 'string', enum: ['string', 'integer', 'boolean', 'list_of_values'] },
          is_required: { type: 'boolean', default: false },
          unit_type: { type: 'string', nullable: true },
          allowed_values: { type: 'array', items: { type: 'string' } },
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
      ProductModelVersion: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          model_id: { type: 'string', format: 'uuid' },
          version: { type: 'integer' },
          snapshot: { $ref: '#/components/schemas/ProductModel' },
          created_at: { type: 'string', format: 'date-time' },
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
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name', 'type', 'connection_config'],
                properties: {
                  name: { type: 'string' },
                  type: { type: 'string', enum: ['csv', 'xml', 'ftp', 'api'] },
                  protocol: { type: 'string', enum: ['HTTP', 'FTP'] },
                  default_model_id: { type: 'string', default: 'google/gemini-flash-1.5' },
                  connection_config: { type: 'object' },
                  schedule_cron: { type: 'string', nullable: true },
                },
              },
            },
          },
        },
        responses: {
          201: { description: 'Created' },
          400: { description: 'Validation error' },
        },
      },
    },
    '/sources/{id}': {
      get: {
        summary: 'Get source details by ID',
        tags: ['Sources'],
        parameters: [
          { $ref: '#/components/parameters/MerchantIdHeader' },
          { in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        responses: {
          200: { description: 'Source details with masked credentials' },
          404: { description: 'Source not found' },
        },
      },
      put: {
        summary: 'Update a source config or credentials',
        tags: ['Sources'],
        parameters: [
          { $ref: '#/components/parameters/MerchantIdHeader' },
          { in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  type: { type: 'string' },
                  connection_config: { type: 'object' },
                  schedule_cron: { type: 'string', nullable: true },
                  status: { type: 'string', enum: ['ACTIVE', 'PAUSED', 'ARCHIVED'] },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Updated source with masked credentials' },
          400: { description: 'Validation error' },
          404: { description: 'Source not found' },
        },
      },
      delete: {
        summary: 'Soft-delete a source (ARCHIVED status)',
        tags: ['Sources'],
        parameters: [
          { $ref: '#/components/parameters/MerchantIdHeader' },
          { in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        responses: {
          200: { description: 'Source archived' },
          404: { description: 'Source not found' },
        },
      },
    },
    '/sources/{id}/sync': {
      post: {
        summary: 'Trigger manual sync pipeline for a source',
        tags: ['Sources'],
        parameters: [
          { $ref: '#/components/parameters/MerchantIdHeader' },
          { in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        responses: {
          202: { description: 'Sync run initiated asynchronously' },
          404: { description: 'Source not found' },
        },
      },
    },
    '/sources/{id}/runs': {
      get: {
        summary: 'Get ingestion run history for a source',
        tags: ['Sources'],
        parameters: [
          { $ref: '#/components/parameters/MerchantIdHeader' },
          { in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        responses: {
          200: { description: 'List of ingestion runs' },
          404: { description: 'Source not found' },
        },
      },
    },
    '/health': {
      get: {
        summary: 'Health check',
        tags: ['Utility & Testing'],
        responses: { 200: { description: 'OK' } }
      }
    },
    '/ingest-csv': {
      post: {
        summary: 'Ingest local CSV file directly',
        tags: ['Utility & Testing'],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { filePath: { type: 'string', default: 'mock_pushop.csv' } }
              }
            }
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
                        key: { type: 'string' },
                        data_type: { type: 'string', enum: ['string', 'integer', 'boolean', 'list_of_values'] },
                        is_required: { type: 'boolean', default: false },
                        unit_type: { type: 'string', nullable: true },
                        allowed_values: { type: 'array', items: { type: 'string' } },
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
        summary: 'Get product model by ID (supports historical schema version query)',
        tags: ['Models'],
        parameters: [
          { $ref: '#/components/parameters/MerchantIdHeader' },
          { in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' }, description: 'Model UUID' },
          { in: 'query', name: 'version', required: false, schema: { type: 'integer' }, description: 'Historical schema version to retrieve (defaults to latest active)' }
        ],
        responses: {
          200: { description: 'Product model details or historical version snapshot' },
          400: { description: 'Invalid version query parameter' },
          403: { description: 'Forbidden: Access to other merchant model rejected' },
          404: { description: 'Model or schema version not found' }
        }
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
    },
    '/models/{id}/attributes': {
      get: {
        summary: 'List attributes defined for a model',
        tags: ['Model Attributes'],
        parameters: [
          { $ref: '#/components/parameters/MerchantIdHeader' },
          { in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' }, description: 'Model UUID' }
        ],
        responses: {
          200: { description: 'List of model attributes' },
          404: { description: 'Model not found' }
        }
      },
      post: {
        summary: 'Add an attribute to a model (increments schema_version and records snapshot)',
        tags: ['Model Attributes'],
        parameters: [
          { $ref: '#/components/parameters/MerchantIdHeader' },
          { in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' }, description: 'Model UUID' }
        ],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name', 'data_type'],
                properties: {
                  name: { type: 'string' },
                  key: { type: 'string', pattern: '^[a-z0-9_]+$' },
                  data_type: { type: 'string', enum: ['string', 'integer', 'boolean', 'list_of_values'] },
                  is_required: { type: 'boolean', default: false },
                  unit_type: { type: 'string', nullable: true },
                  allowed_values: { type: 'array', items: { type: 'string' } }
                }
              }
            }
          }
        },
        responses: {
          201: { description: 'Attribute added successfully' },
          400: { description: 'Validation error (e.g. invalid key or missing allowed_values)' },
          403: { description: 'Forbidden: Global template cannot be modified' },
          404: { description: 'Model not found' }
        }
      }
    },
    '/models/{id}/attributes/{attributeId}': {
      put: {
        summary: 'Update an attribute definition on a model (increments schema_version and records snapshot)',
        tags: ['Model Attributes'],
        parameters: [
          { $ref: '#/components/parameters/MerchantIdHeader' },
          { in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' }, description: 'Model UUID' },
          { in: 'path', name: 'attributeId', required: true, schema: { type: 'string', format: 'uuid' }, description: 'Attribute UUID' }
        ],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  key: { type: 'string', pattern: '^[a-z0-9_]+$' },
                  data_type: { type: 'string', enum: ['string', 'integer', 'boolean', 'list_of_values'] },
                  is_required: { type: 'boolean' },
                  unit_type: { type: 'string', nullable: true },
                  allowed_values: { type: 'array', items: { type: 'string' } }
                }
              }
            }
          }
        },
        responses: {
          200: { description: 'Attribute updated' },
          400: { description: 'Validation error' },
          404: { description: 'Attribute or model not found' }
        }
      },
      delete: {
        summary: 'Delete an attribute from a model (increments schema_version and records snapshot)',
        tags: ['Model Attributes'],
        parameters: [
          { $ref: '#/components/parameters/MerchantIdHeader' },
          { in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' }, description: 'Model UUID' },
          { in: 'path', name: 'attributeId', required: true, schema: { type: 'string', format: 'uuid' }, description: 'Attribute UUID' }
        ],
        responses: {
          200: { description: 'Attribute deleted successfully' },
          404: { description: 'Attribute or model not found' }
        }
      }
    },
    '/models/{id}/versions': {
      get: {
        summary: 'List historical schema versions and immutable snapshots for a model',
        tags: ['Models'],
        parameters: [
          { $ref: '#/components/parameters/MerchantIdHeader' },
          { in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' }, description: 'Model UUID' }
        ],
        responses: {
          200: { description: 'List of historical versions and snapshots' },
          404: { description: 'Model not found' }
        }
      }
    },
    '/products': {
      get: {
        summary: 'Query the paginated review queue of extracted products',
        tags: ['Products'],
        parameters: [
          { $ref: '#/components/parameters/MerchantIdHeader' },
          { in: 'query', name: 'state', schema: { type: 'string', enum: ['PROCESSING', 'NEEDS_REVIEW', 'ENRICHED', 'FAILED_EXTRACTION'] }, description: 'Filter by product state' },
          { in: 'query', name: 'job_id', schema: { type: 'string', format: 'uuid' }, description: 'Filter by extraction job UUID' },
          { in: 'query', name: 'page', schema: { type: 'integer', default: 1 }, description: 'Page number' },
          { in: 'query', name: 'limit', schema: { type: 'integer', default: 20 }, description: 'Items per page (max 100)' }
        ],
        responses: {
          200: {
            description: 'Paginated product review queue with active gaps',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          id: { type: 'string', format: 'uuid' },
                          merchant_id: { type: 'string', format: 'uuid' },
                          job_id: { type: 'string', format: 'uuid' },
                          model_version_id: { type: 'string', format: 'uuid' },
                          supplier_sku: { type: 'string' },
                          state: { type: 'string', enum: ['PROCESSING', 'NEEDS_REVIEW', 'ENRICHED', 'FAILED_EXTRACTION'] },
                          gaps: { type: 'array', items: { type: 'object' } },
                          created_at: { type: 'string', format: 'date-time' },
                          updated_at: { type: 'string', format: 'date-time' }
                        }
                      }
                    },
                    pagination: {
                      type: 'object',
                      properties: {
                        page: { type: 'integer' },
                        limit: { type: 'integer' },
                        total: { type: 'integer' },
                        totalPages: { type: 'integer' }
                      }
                    }
                  }
                }
              }
            }
          },
          400: { description: 'Invalid query parameters' }
        }
      }
    },
    '/products/{id}': {
      get: {
        summary: 'Retrieve single product detail with gaps and extracted attributes',
        tags: ['Products'],
        parameters: [
          { $ref: '#/components/parameters/MerchantIdHeader' },
          { in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' }, description: 'Product UUID' }
        ],
        responses: {
          200: {
            description: 'Product detail with active gaps and extracted attributes',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    id: { type: 'string', format: 'uuid' },
                    merchant_id: { type: 'string', format: 'uuid' },
                    job_id: { type: 'string', format: 'uuid' },
                    model_version_id: { type: 'string', format: 'uuid' },
                    supplier_sku: { type: 'string' },
                    state: { type: 'string' },
                    gaps: { type: 'array', items: { type: 'object' } },
                    attributes: { type: 'array', items: { type: 'object' } },
                    created_at: { type: 'string', format: 'date-time' },
                    updated_at: { type: 'string', format: 'date-time' }
                  }
                }
              }
            }
          },
          404: { description: 'Product not found' }
        }
      }
    },
    '/products/{id}/attributes': {
      put: {
        summary: 'Manually override product attributes, clear resolved gaps, and evaluate promotion',
        tags: ['Products'],
        parameters: [
          { $ref: '#/components/parameters/MerchantIdHeader' },
          { in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' }, description: 'Product UUID' },
          { in: 'header', name: 'x-user-id', required: false, schema: { type: 'string' }, description: 'Operator user identifier' }
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['attributes'],
                properties: {
                  attributes: {
                    type: 'object',
                    description: 'Key-value map of attributes to override',
                    example: {
                      weight: 1250,
                      color: 'matte black'
                    }
                  }
                }
              }
            }
          }
        },
        responses: {
          200: {
            description: 'Attributes successfully updated and gaps re-evaluated',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    product_id: { type: 'string', format: 'uuid' },
                    state: { type: 'string', enum: ['NEEDS_REVIEW', 'ENRICHED'] },
                    remaining_gaps_count: { type: 'integer' },
                    message: { type: 'string' }
                  }
                }
              }
            }
          },
          400: { description: 'Schema validation error (SCHEMA_VALIDATION_ERROR)' },
          404: { description: 'Product not found' },
          409: { description: 'Conflict on illegal promotion' }
        }
      }
    }
  },
};