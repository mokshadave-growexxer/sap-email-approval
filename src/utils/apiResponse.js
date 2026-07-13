export const apiResponse = {
  success: ({ data = null, message = 'Success', statusCode = 200, meta = null }) => ({
    status: 'success',
    statusCode,
    message,
    data,
    meta,
  }),

  error: ({ message = 'Error', statusCode = 500, errors = null }) => ({
    status: 'error',
    statusCode,
    message,
    errors,
  }),

  notFound: (message = 'Not found') => ({
    status: 'error',
    statusCode: 404,
    message,
  }),
};
