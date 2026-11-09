const requestHandler = require('../server');

module.exports = (req, res) => {
  if (req.url === '/api/index.js' || req.url.startsWith('/api/index.js')) {
    const rawPath = req.headers['x-matched-path'] || req.headers['x-original-url'] || req.headers['x-forwarded-uri'];
    if (rawPath) {
      req.url = rawPath;
    }
  }
  return requestHandler(req, res);
};

