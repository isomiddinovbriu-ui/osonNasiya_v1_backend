const { Client } = require('minio');

function createProductStorage(config) {
  const client = new Client({
    endPoint: config.minioEndPoint,
    port: config.minioPort,
    useSSL: config.minioUseSsl,
    accessKey: config.minioAccessKey,
    secretKey: config.minioSecretKey,
  });
  const bucket = config.minioBucket;
  let readyPromise;
  return {
    async ensureBucket() {
      if (!readyPromise) {
        readyPromise = (async () => {
          if (!await client.bucketExists(bucket)) await client.makeBucket(bucket);
        })().catch((error) => {
          readyPromise = null;
          throw error;
        });
      }
      return readyPromise;
    },
    async putObject(objectName, buffer, mime) {
      return client.putObject(bucket, objectName, buffer, buffer.length, { 'Content-Type': mime });
    },
    async getObject(objectName) { return client.getObject(bucket, objectName); },
    async removeObject(objectName) { return client.removeObject(bucket, objectName); },
  };
}

module.exports = { createProductStorage };
