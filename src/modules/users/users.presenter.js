function publicUser(user) {
  return {
    id: user._id.toString(),
    login: user.login,
    role: user.role,
    name: user.name || '',
    description: user.description || '',
    avatarUrl: user.avatar ? `/api/public/avatars/${user._id}` : null,
  };
}

module.exports = { publicUser };
