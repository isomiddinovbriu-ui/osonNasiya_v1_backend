function publicRegion(region) {
  return {
    id: region._id.toString(),
    name: region.name,
    description: region.description,
    createdBy: region.createdBy.toString(),
    createdAt: region.createdAt,
  };
}

module.exports = { publicRegion };
