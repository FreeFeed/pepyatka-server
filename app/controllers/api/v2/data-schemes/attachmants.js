import definitions from '../../v1/data-schemes/definitions';

export const getAttachmentsByIdsInputSchema = {
  $schema: 'http://json-schema.org/schema#',

  definitions,

  type: 'object',
  required: ['ids'],

  properties: {
    ids: {
      type: 'array',
      items: { $ref: '#/definitions/uuid' },
      uniqueItems: true,
      default: [],
    },
  },
};
