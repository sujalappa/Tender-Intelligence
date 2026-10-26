// CloudFront Function (viewer request) for the client distribution.
// Serves index.html for client-side routes (/tenders/123, /summary-keys…) so
// a refresh or a shared link doesn't 404, while real files (/assets/…,
// anything with an extension) are served as they are.
function handler(event) {
  var request = event.request;
  var uri = request.uri;
  if (uri.indexOf("/assets/") !== 0 && uri.lastIndexOf(".") <= uri.lastIndexOf("/")) {
    request.uri = "/index.html";
  }
  return request;
}
