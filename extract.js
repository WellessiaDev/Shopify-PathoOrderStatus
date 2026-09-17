app.get(
  '/api/test/pathao-auth',
  async (req, res) => {

    try {

      const token =
        await getPathaoToken();

      res.json({
        success: true,
        message:
          'Pathao authentication successful',
        access_token_received:
          !!token,
        refresh_token_received:
          !!PATHAO_REFRESH_TOKEN
      });

    } catch (error) {

      res.status(500).json({
        success: false,
        error: error.message
      });

    }
  }
);
